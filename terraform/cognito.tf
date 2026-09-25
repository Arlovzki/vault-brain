# Cognito OAuth for the MCP server. Interactive login through the Hosted UI.
# The Lambda accepts EITHER a valid Cognito access token OR the static bearer
# (fallback), so scripted clients and smoke tests work without a browser while
# interactive MCP clients use the OAuth path.

resource "aws_cognito_user_pool" "vault" {
  name                     = var.project_name
  username_attributes      = ["email"]
  auto_verified_attributes = ["email"]

  # This single-user template only needs email and password sign-in. Review the
  # current Cognito feature and pricing documentation before deploying.
  user_pool_tier = "LITE"

  # Strong enough for an owner account while remaining practical for a workshop.
  password_policy {
    minimum_length    = 12
    require_lowercase = true
    require_uppercase = true
    require_numbers   = true
    require_symbols   = false
  }

  admin_create_user_config {
    allow_admin_create_user_only = true
  }
}

resource "aws_cognito_user_pool_domain" "vault" {
  domain       = local.cognito_domain
  user_pool_id = aws_cognito_user_pool.vault.id
}

resource "aws_cognito_user_pool_client" "mcp" {
  name         = "${var.project_name}-mcp"
  user_pool_id = aws_cognito_user_pool.vault.id

  # Public client: browser and CLI OAuth clients use PKCE and cannot safely hold
  # a client secret. A confidential client would fail those integrations.
  generate_secret                      = false
  allowed_oauth_flows_user_pool_client = true
  allowed_oauth_flows                  = ["code"]
  allowed_oauth_scopes                 = ["openid", "email", "profile"]
  supported_identity_providers         = ["COGNITO"]

  callback_urls = ["http://localhost:${var.oauth_callback_port}/callback"]

  explicit_auth_flows = ["ALLOW_REFRESH_TOKEN_AUTH", "ALLOW_USER_SRP_AUTH"]

  # Short-lived access tokens, longer refresh.
  access_token_validity  = 1
  id_token_validity      = 1
  refresh_token_validity = 30
  token_validity_units {
    access_token  = "hours"
    id_token      = "hours"
    refresh_token = "days"
  }

  # The MCP server registers approved callback URLs at runtime through the RFC
  # 7591 DCR bridge. Ignore callback drift so a later apply does not remove an
  # active client's runtime registration.
  lifecycle {
    ignore_changes = [callback_urls]
  }
}

# The single vault owner. random_password only SEEDS a password at create time;
# Cognito never reads it back, so the Node workshop runner sets the live password
# through the AWS SDK after Terraform finishes.
# ignore_changes stops `terraform apply` from ever touching the real password.
resource "random_password" "owner" {
  length           = 20
  special          = true
  override_special = "!@#%^*-_=+"
}

resource "aws_cognito_user" "owner" {
  user_pool_id = aws_cognito_user_pool.vault.id
  username     = var.owner_email

  attributes = {
    email          = var.owner_email
    email_verified = "true"
  }

  password = random_password.owner.result

  lifecycle {
    ignore_changes = [password]
  }
}
