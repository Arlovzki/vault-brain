#!/usr/bin/env bash
# Deploy one vault-brain stack, in the only order that works:
#
#   1) Build the Lambda bundle. Terraform zips mcp-server/dist, so a stale or
#      missing dist means deploying stale or missing code.
#   2) terraform apply.
#   3) Seed the starter vault, but only into an empty bucket.
#   4) Print everything the runbook's remaining manual steps need.
#
# Run it from anywhere; it locates the repo itself.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TF=(terraform -chdir="$ROOT/terraform")
AUTO_APPROVE="false"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --yes|-y)  AUTO_APPROVE="true"; shift ;;
    -h|--help) echo "usage: deploy.sh [--yes]"; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 1 ;;
  esac
done

banner() { printf '\n\033[1;35m>> %s\033[0m\n' "$*"; }

if [[ ! -f "$ROOT/terraform/terraform.tfvars" ]]; then
  echo "error: terraform/terraform.tfvars is missing." >&2
  echo "Copy terraform/terraform.tfvars.example to terraform/terraform.tfvars and fill it in." >&2
  exit 1
fi

banner "1/4  Build the MCP Lambda bundle"
cd "$ROOT/mcp-server"
if [[ -f package-lock.json ]]; then npm ci; else npm install; fi
npm run build

banner "2/4  Terraform apply"
"${TF[@]}" init -input=false
if [[ "$AUTO_APPROVE" == "true" ]]; then
  "${TF[@]}" apply -input=false -auto-approve
else
  "${TF[@]}" apply -input=false
fi

CONNECTOR_URL="$("${TF[@]}" output -raw mcp_connector_url)"
HOSTED_UI="$("${TF[@]}" output -raw cognito_hosted_ui_url)"
BUCKET="$("${TF[@]}" output -raw vault_bucket)"
REGION="$("${TF[@]}" output -raw region)"
PROFILE="$("${TF[@]}" output -raw aws_profile)"
POOL_ID="$("${TF[@]}" output -raw cognito_user_pool_id)"
EMAIL="$("${TF[@]}" output -raw cognito_login_email)"

banner "3/4  Seed the starter vault (only if the vault is empty)"
# Fail closed: if the list itself errors (expired SSO, AccessDenied, wrong region),
# we must NOT read that as "empty" and sync the starter over a populated vault. So
# capture the CLI's exit status instead of swallowing it with 2>/dev/null || true.
# Use `aws s3 ls` rather than `s3api list-objects-v2`: some aws-cli builds (e.g. on
# Python 3.14) reject the generated s3api command with "badly formed help string".
# .trash/ is excluded so a vault whose notes were all trashed still counts as
# non-empty and is left alone.
if ! VAULT_LISTING="$(aws s3 ls "s3://$BUCKET/" --recursive --profile "$PROFILE" --region "$REGION")"; then
  echo "error: could not list s3://$BUCKET to check whether it is empty; refusing to seed." >&2
  echo "Check the AWS profile / SSO session and re-run." >&2
  exit 1
fi
if printf '%s\n' "$VAULT_LISTING" | grep -v '\.trash/' | grep -q '\.md'; then
  echo "Vault already has notes. Leaving it alone."
else
  aws s3 sync "$ROOT/vault-starter/" "s3://$BUCKET/" --profile "$PROFILE" --region "$REGION"
  echo "Seeded the starter vault."
fi

banner "4/4  What is left to do by hand"
cat <<EOF

MCP endpoint (use this when configuring a compatible MCP client):
  $CONNECTOR_URL

Cognito sign-in URL:
  $HOSTED_UI
  username: $EMAIL

Set a permanent owner password now. Pick at least 12 characters and include an
uppercase letter, a lowercase letter, and a number:

  aws cognito-idp admin-set-user-password \\
    --user-pool-id $POOL_ID \\
    --username $EMAIL \\
    --password 'YOUR-PASSWORD' \\
    --permanent \\
    --profile $PROFILE --region $REGION

Protect terraform/terraform.tfstate. It contains the bootstrap password and
other credentials created for this stack.

Remotely Save (Obsidian plugin) settings:
  service:  S3
  endpoint: https://s3.$REGION.amazonaws.com
  region:   $REGION
  bucket:   $BUCKET
  keys:     terraform -chdir=terraform output -raw sync_access_key_id
            terraform -chdir=terraform output -raw sync_secret_access_key

Smoke test the endpoint now:
  scripts/smoke.sh

EOF
