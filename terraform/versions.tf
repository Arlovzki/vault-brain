terraform {
  required_version = ">= 1.10, < 2.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 5.0, < 7.0"
    }
    random = {
      source  = "hashicorp/random"
      version = ">= 3.0, < 4.0"
    }
    archive = {
      source  = "hashicorp/archive"
      version = ">= 2.0, < 3.0"
    }
  }
}

provider "aws" {
  region              = var.region
  profile             = var.profile
  allowed_account_ids = [var.expected_account_id]

  default_tags {
    tags = {
      Project   = var.project_name
      ManagedBy = "terraform"
    }
  }
}

data "aws_caller_identity" "current" {}

locals {
  account_id = data.aws_caller_identity.current.account_id

  # Bucket names are globally unique, so the account id is the disambiguator.
  vault_bucket_name = var.vault_bucket_name != "" ? var.vault_bucket_name : "${var.project_name}-vault-${local.account_id}"
  sync_user_name    = var.sync_user_name != "" ? var.sync_user_name : "${var.project_name}-sync"

  # Cognito hosted-UI domain prefixes are also globally unique.
  cognito_domain = "${var.project_name}-${local.account_id}"
}
