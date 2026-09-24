# Least-privilege IAM user for the Obsidian Remotely Save plugin: this one bucket,
# nothing else.
#
# Terraform manages the access key so a new deployment can configure the sync
# plugin immediately. The secret is stored in terraform.tfstate alongside other
# credentials, so protect and back up that file. Rotate this key if it is exposed.

resource "aws_iam_user" "sync" {
  name = local.sync_user_name
}

resource "aws_iam_access_key" "sync" {
  user = aws_iam_user.sync.name
}

resource "aws_iam_user_policy" "sync_s3" {
  name = "${local.sync_user_name}-s3"
  user = aws_iam_user.sync.name

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "ListThisBucket"
        Effect   = "Allow"
        Action   = "s3:ListBucket"
        Resource = aws_s3_bucket.vault.arn
      },
      {
        Sid      = "RWObjectsInThisBucket"
        Effect   = "Allow"
        Action   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"]
        Resource = "${aws_s3_bucket.vault.arn}/*"
      }
    ]
  })
}
