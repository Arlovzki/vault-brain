terraform {
  required_version = ">= 1.5"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 5.0"
    }
    random = {
      source  = "hashicorp/random"
      version = ">= 3.0"
    }
    archive = {
      source  = "hashicorp/archive"
      version = ">= 2.0"
    }
  }

  # State is deliberately LOCAL (terraform.tfstate next to these files).
  # vault-brain is a template: one stack per person, in that person's own AWS
  # account, applied from that person's laptop. A shared remote backend would
  # need a bootstrap bucket per deployment. Protect terraform.tfstate because it
  # contains the bearer token, sync secret key, and Cognito bootstrap password.
  # Losing it removes Terraform's resource mapping and can require imports or
  # credential rotation before the stack can be managed safely again.
}

provider "aws" {
  region  = var.region
  profile = var.profile

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
