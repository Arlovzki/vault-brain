variable "project_name" {
  description = "Prefix for every resource name in this stack, e.g. 'vault-brain-demo' or 'vault-brain-alex'. Lowercase letters, digits and hyphens only: it ends up in S3 bucket and Cognito domain names."
  type        = string

  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$", var.project_name))
    error_message = "project_name must be 3-40 chars of lowercase letters, digits and hyphens, and cannot start or end with a hyphen."
  }
}

variable "profile" {
  description = "AWS CLI profile used to apply this Terraform."
  type        = string
}

variable "owner_email" {
  description = "Email of the single Cognito user who owns this vault. Becomes the sign-in username."
  type        = string
}

variable "region" {
  description = "AWS region for the whole stack."
  type        = string
}

variable "vault_bucket_name" {
  description = "S3 bucket holding the Obsidian vault. Empty means auto: '<project_name>-vault-<account-id>'. Set this only to adopt an existing bucket."
  type        = string
  default     = ""
}

variable "sync_user_name" {
  description = "IAM user the Remotely Save plugin authenticates as. Empty means auto: '<project_name>-sync'."
  type        = string
  default     = ""
}

variable "oauth_callback_port" {
  description = "Loopback port used by CLI MCP clients for OAuth callbacks. Remote clients register approved callbacks through the DCR bridge."
  type        = number
  default     = 9000
}

variable "vault_tz" {
  description = "IANA time zone defining the vault's local day (capture dates, filename prefixes, the modified column in list_notes)."
  type        = string
  default     = "UTC"
}
