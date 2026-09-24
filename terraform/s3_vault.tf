# The vault bucket: synced by the Obsidian Remotely Save plugin on every device,
# and read and written by the MCP Lambda. One bucket, both jobs.

resource "aws_s3_bucket" "vault" {
  bucket = local.vault_bucket_name
}

resource "aws_s3_bucket_versioning" "vault" {
  bucket = aws_s3_bucket.vault.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "vault" {
  bucket = aws_s3_bucket.vault.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_public_access_block" "vault" {
  bucket                  = aws_s3_bucket.vault.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# Required for the Remotely Save plugin to sync from the Obsidian app. The plugin
# talks to S3 from a browser-ish context (Electron on desktop, Capacitor on
# Android), so without these origins the sync fails on CORS preflight.
resource "aws_s3_bucket_cors_configuration" "vault" {
  bucket = aws_s3_bucket.vault.id

  cors_rule {
    allowed_headers = ["*"]
    allowed_methods = ["GET", "PUT", "POST", "DELETE", "HEAD"]
    allowed_origins = ["app://obsidian.md", "capacitor://localhost", "http://localhost"]
    expose_headers  = ["ETag", "Content-Length", "Content-Type", "Content-Encoding", "Content-Range", "Content-Disposition"]
  }
}

# Versioning is the vault's undo, but old versions should not accumulate forever.
resource "aws_s3_bucket_lifecycle_configuration" "vault" {
  bucket = aws_s3_bucket.vault.id

  rule {
    id     = "delete-old-note-versions-30d"
    status = "Enabled"

    filter {
      prefix = ""
    }

    noncurrent_version_expiration {
      noncurrent_days = 30
    }

    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }
}
