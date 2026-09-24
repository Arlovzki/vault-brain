# Execution role for the MCP Lambda, scoped to the vault bucket and the pool's
# one app client.

data "aws_iam_policy_document" "lambda_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "mcp_lambda" {
  name               = "${var.project_name}-mcp-lambda"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

# CloudWatch Logs.
resource "aws_iam_role_policy_attachment" "lambda_logs" {
  role       = aws_iam_role.mcp_lambda.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

data "aws_iam_policy_document" "mcp_lambda" {
  # The DCR bridge merges a connector's redirect URIs into the one app client.
  statement {
    sid       = "DcrManageClient"
    actions   = ["cognito-idp:DescribeUserPoolClient", "cognito-idp:UpdateUserPoolClient"]
    resources = [aws_cognito_user_pool.vault.arn]
  }

  statement {
    sid       = "VaultList"
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.vault.arn]
  }

  statement {
    sid       = "VaultObjects"
    actions   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"]
    resources = ["${aws_s3_bucket.vault.arn}/*"]
  }
}

resource "aws_iam_role_policy" "mcp_lambda" {
  name   = "${var.project_name}-mcp-lambda"
  role   = aws_iam_role.mcp_lambda.id
  policy = data.aws_iam_policy_document.mcp_lambda.json
}
