output "state_bucket" {
  description = "Private S3 bucket used by the Vault Brain Terraform backends."
  value       = aws_s3_bucket.terraform_state.bucket
}

output "aws_account_id" {
  description = "AWS account that owns this state bucket."
  value       = data.aws_caller_identity.current.account_id
}

output "aws_profile" {
  description = "AWS CLI profile used to manage this state bucket."
  value       = var.profile
}

output "region" {
  description = "AWS region that stores this state bucket."
  value       = var.region
}
