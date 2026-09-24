output "mcp_connector_url" {
  description = "MCP endpoint for a compatible remote client."
  value       = "${aws_apigatewayv2_api.mcp.api_endpoint}/mcp"
}

output "mcp_bearer_token" {
  description = "Static fallback bearer for scripted clients and smoke tests. Read it with: terraform output -raw mcp_bearer_token"
  value       = random_password.mcp_bearer.result
  sensitive   = true
}

output "cognito_hosted_ui_url" {
  description = "Cognito Hosted UI domain used for interactive sign-in."
  value       = "https://${aws_cognito_user_pool_domain.vault.domain}.auth.${var.region}.amazoncognito.com"
}

output "cognito_login_email" {
  description = "Username for the Hosted UI sign-in."
  value       = aws_cognito_user.owner.username
}

output "cognito_user_pool_id" {
  description = "Needed for the one-time `aws cognito-idp admin-set-user-password` call."
  value       = aws_cognito_user_pool.vault.id
}

output "cognito_client_id" {
  description = "Public OAuth client id (PKCE, no secret), for CLI MCP clients."
  value       = aws_cognito_user_pool_client.mcp.id
}

output "vault_bucket" {
  description = "The vault's S3 bucket. Configure Remotely Save against this."
  value       = aws_s3_bucket.vault.bucket
}

output "sync_access_key_id" {
  description = "Access key for the Remotely Save plugin. Read it with: terraform output -raw sync_access_key_id"
  value       = aws_iam_access_key.sync.id
  sensitive   = true
}

output "sync_secret_access_key" {
  description = "Secret key for the Remotely Save plugin. Read it with: terraform output -raw sync_secret_access_key"
  value       = aws_iam_access_key.sync.secret
  sensitive   = true
}

output "region" {
  description = "Region the stack runs in. Remotely Save needs it alongside the bucket."
  value       = var.region
}

output "aws_profile" {
  description = "Profile this stack was applied with. deploy.sh and smoke.sh reuse it for their AWS CLI calls."
  value       = var.profile
}
