# The MCP server: a Lambda bundled from ../mcp-server/dist, fronted by an HTTP API.
# Build the bundle first:  cd ../mcp-server && npm ci && npm run build
# (scripts/deploy.sh does this in the right order.)

# Static fallback bearer, used by smoke tests and any client that cannot do OAuth.
# Stored in local state, which is why terraform.tfstate is a secret.
resource "random_password" "mcp_bearer" {
  length  = 40
  special = false
}

data "archive_file" "mcp" {
  type        = "zip"
  source_dir  = "${path.module}/../mcp-server/dist"
  output_path = "${path.module}/build/mcp.zip"
}

resource "aws_lambda_function" "mcp" {
  function_name    = "${var.project_name}-mcp"
  role             = aws_iam_role.mcp_lambda.arn
  runtime          = "nodejs22.x"
  handler          = "index.handler"
  filename         = data.archive_file.mcp.output_path
  source_code_hash = data.archive_file.mcp.output_base64sha256
  timeout          = 30
  memory_size      = 512

  environment {
    variables = {
      VAULT_BUCKET         = aws_s3_bucket.vault.bucket
      MCP_BEARER_TOKEN     = random_password.mcp_bearer.result
      COGNITO_USER_POOL_ID = aws_cognito_user_pool.vault.id
      COGNITO_CLIENT_ID    = aws_cognito_user_pool_client.mcp.id
      COGNITO_ISSUER       = "https://cognito-idp.${var.region}.amazonaws.com/${aws_cognito_user_pool.vault.id}"
      MCP_RESOURCE_URL     = aws_apigatewayv2_api.mcp.api_endpoint
      VAULT_TZ             = var.vault_tz
    }
  }

  depends_on = [aws_iam_role_policy_attachment.lambda_logs]
}

# Declared so the log group has a retention policy. Lambda would otherwise create
# it implicitly on first invocation with retention set to "never expire", making
# it the one store in the stack that grows without bound.
resource "aws_cloudwatch_log_group" "mcp" {
  name              = "/aws/lambda/${var.project_name}-mcp"
  retention_in_days = 30
}

resource "aws_apigatewayv2_api" "mcp" {
  name          = "${var.project_name}-mcp"
  protocol_type = "HTTP"

  # Permissive CORS. There is no web HUD here, so this grants nothing on its own
  # (every MCP route still requires a bearer), but it keeps browser-based MCP
  # clients working without another apply.
  cors_configuration {
    allow_origins = ["*"]
    allow_methods = ["GET", "POST", "OPTIONS"]
    # The MCP Streamable HTTP transport sends MCP-Protocol-Version (and a session id)
    # on every post-initialize request; a browser client's preflight fails without
    # these in the allowlist, and smoke.sh (curl, no preflight) would not catch it.
    allow_headers = ["authorization", "content-type", "mcp-protocol-version", "mcp-session-id"]
    max_age       = 300
  }
}

resource "aws_apigatewayv2_integration" "mcp" {
  api_id                 = aws_apigatewayv2_api.mcp.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.mcp.invoke_arn
  payload_format_version = "2.0"
}

# Catch-all so the Lambda serves both the public OAuth discovery routes and /mcp.
resource "aws_apigatewayv2_route" "mcp" {
  api_id    = aws_apigatewayv2_api.mcp.id
  route_key = "$default"
  target    = "integrations/${aws_apigatewayv2_integration.mcp.id}"
}

resource "aws_apigatewayv2_stage" "mcp" {
  api_id      = aws_apigatewayv2_api.mcp.id
  name        = "$default"
  auto_deploy = true

  # Account-wide backstop against a flood of the unauthenticated routes (/register,
  # the discovery endpoints) or brute-forcing the static bearer. This is a personal
  # single-user vault, so a low ceiling is plenty of headroom.
  default_route_settings {
    throttling_burst_limit = 20
    throttling_rate_limit  = 10
  }
}

resource "aws_lambda_permission" "apigw" {
  statement_id  = "AllowAPIGatewayInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.mcp.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.mcp.execution_arn}/*/*"
}
