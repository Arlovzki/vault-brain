variable "project_name" {
  description = "Vault Brain project name used to derive the globally unique state bucket name."
  type        = string

  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$", var.project_name))
    error_message = "project_name must be 3-40 chars of lowercase letters, digits and hyphens, and cannot start or end with a hyphen."
  }
}

variable "profile" {
  description = "AWS CLI profile used to bootstrap the state bucket."
  type        = string
}

variable "region" {
  description = "AWS region that stores the Terraform state bucket."
  type        = string
}

variable "account_id" {
  description = "Verified AWS account that must own the state bucket."
  type        = string

  validation {
    condition     = can(regex("^[0-9]{12}$", var.account_id))
    error_message = "account_id must be the verified 12-digit AWS account ID."
  }
}
