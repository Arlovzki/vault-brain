# Vault Brain

Vault Brain is a self-hosted MCP server for Markdown notes stored in Amazon S3. It gives compatible AI clients authenticated tools to search, read, create, edit, move, and remove notes without giving those clients direct S3 credentials.

Each deployment is a single-user stack in that person's AWS account. Obsidian support through Remotely Save is optional.

## How it works

```text
ChatGPT, Claude Code, or another MCP client
                    |
            HTTPS with OAuth
                    |
       API Gateway and MCP Lambda
             |              |
       private S3         Cognito
       Markdown vault     login and PKCE
             |
    Obsidian with Remotely Save
              optional
```

The client discovers each tool's name, description, and input schema from the MCP server. The model normally chooses a tool from that metadata and supplies its arguments, so users do not need to mention tool names in ordinary prompts. The server validates the request, performs the S3 operation, and returns the result.

OAuth uses Cognito's authorization-code flow with PKCE S256. S256 is the SHA-256 transform used to prove that the client which started a login is the client completing it. It is not a public key. A small RFC 7591 registration bridge lets supported remote MCP clients register an approved callback URL. A generated static bearer token is also available for scripts and the smoke test.

Terraform manages the AWS resources and keeps local state. S3 stores the vault, while Cognito stores login state and registered callback URLs.

## Tools

| Tool | Behavior |
| --- | --- |
| `describe_schema` | Returns the owner-controlled `System/schema.md` conventions. |
| `capture` | Creates a dated Markdown note in `+Inbox/` or another allowed folder. |
| `list_inbox` | Lists up to 500 Markdown notes waiting in `+Inbox/`. |
| `list_notes` | Lists paths, sizes, and modified dates without reading note bodies. Returns at most 500 entries. |
| `read_note` | Reads one Markdown note by its vault-relative path. |
| `search_vault` | Runs a case-insensitive text search. It scans at most 2,000 notes, skips notes over 1 MB, and returns at most 100 matches. |
| `edit_note` | Replaces an exact text snippet, with an explicit option to replace every occurrence. |
| `write_note` | Creates a Markdown note. Existing notes are replaced only when `overwrite: true` is supplied. |
| `move_note` | Moves or renames a note. Existing destinations require `overwrite: true`; wikilinks are not rewritten. |
| `trash_note` | Moves a note into `.trash/` so it can be restored with `move_note`. |
| `delete_note` | Deletes one note from the current vault view. S3 version history can recover it during the configured retention window. |
| `find_orphans` | Checks up to 2,000 eligible notes for orphaned notes and dangling wikilinks. Notes over 1 MB are skipped. |

The server limits MCP file access to Markdown notes, excludes Obsidian configuration, and reserves the `System/` namespace from tool-driven changes. Edit system rules directly as the vault owner.

## Prerequisites

- Git and Bash
- AWS CLI configured with a personal AWS account and named profile
- Terraform 1.5 or newer
- Node.js 22 and npm
- AWS permissions to manage IAM, S3, Lambda, API Gateway, Cognito, and CloudWatch Logs
- At least one MCP-capable client, such as ChatGPT or Claude Code
- Obsidian and Remotely Save only if you want local vault sync

## 1. Clone and run the preflight checks

```bash
git clone https://github.com/Arlovzki/vault-brain.git
cd vault-brain

git --version
bash --version
aws --version
terraform version
node --version
npm --version

npm --prefix mcp-server ci
terraform -chdir=terraform init
```

Confirm that the AWS profile resolves to the intended account:

```bash
aws sts get-caller-identity --profile <PROFILE>
```

Do not deploy until the returned account ID is yours.

## 2. Configure the stack

```bash
cp terraform/terraform.tfvars.example terraform/terraform.tfvars
```

Edit `terraform/terraform.tfvars`:

```hcl
project_name = "vault-brain-yourname"
profile      = "default"
owner_email  = "you@example.com"
region       = "us-east-1"
vault_tz     = "UTC"
```

Use a unique, lowercase `project_name` because it becomes part of globally unique S3 and Cognito names. Pick the AWS region intentionally. `terraform.tfvars` and Terraform state are local secrets and must not be committed.

## 3. Build and deploy

```bash
bash scripts/deploy.sh
```

Review the Terraform plan before approving it. The script:

1. Installs the locked Node dependencies and builds the Lambda bundle.
2. Initializes and applies Terraform.
3. Seeds the starter Markdown files only when the bucket contains no notes.
4. Prints the MCP endpoint, Cognito details, and Obsidian settings.

## 4. Set the owner password

Terraform creates the Cognito user with a generated bootstrap password. That bootstrap value is stored in local Terraform state. Replace it with a permanent password after deployment:

```bash
aws cognito-idp admin-set-user-password \
  --user-pool-id <PRINTED_POOL_ID> \
  --username <OWNER_EMAIL> \
  --password 'YOUR-PASSWORD' \
  --permanent \
  --profile <PROFILE> \
  --region <REGION>
```

Use at least 12 characters with lowercase letters, uppercase letters, and numbers. The permanent password is managed by Cognito and is not written back to Terraform state.

## 5. Connect an MCP client

Use the endpoint printed by `deploy.sh`. It must include the final `/mcp` path. Complete the Cognito sign-in when the client opens a browser.

### Claude Code

Claude Code's [MCP guide](https://code.claude.com/docs/en/mcp) documents remote HTTP servers, OAuth login, and fixed callback ports. Add Vault Brain at user scope:

```bash
claude mcp add --transport http --scope user --callback-port 9000 vault-brain <MCP_URL>
claude mcp login vault-brain
claude mcp list
```

The final command should show `vault-brain` as connected.

### ChatGPT

OpenAI's current [MCP connection guide](https://developers.openai.com/plugins/deploy/connect-chatgpt) documents this developer-mode flow:

1. Open ChatGPT Settings, then Security and login.
2. Enable Developer mode. Availability can depend on account or workspace policy.
3. Open ChatGPT Plugins and add a new connection.
4. Name it `Vault Brain` and paste the public endpoint, including `/mcp`.
5. Complete the Cognito sign-in, review the discovered tools, and add Vault Brain to a new conversation.

Product labels can move over time, but the connection still needs the public HTTPS MCP endpoint and browser-based OAuth login.

Test either client with:

> Before changing anything, read this vault's rules and tell me what each top-level folder is for.

The answer should be grounded in `System/schema.md`.

## 6. Run the smoke test

```bash
bash scripts/smoke.sh
```

The smoke test reads the endpoint and static bearer from Terraform outputs, verifies all 12 tools, performs a temporary capture, read, and trash round trip, rejects an unauthenticated request, and checks public OAuth discovery.

## 7. Optional: sync the vault to Obsidian

Create a new, empty Obsidian vault. Install and enable the Remotely Save community plugin, then select its S3-compatible service.

Retrieve the settings on a private screen:

```bash
terraform -chdir=terraform output -raw vault_bucket
terraform -chdir=terraform output -raw region
terraform -chdir=terraform output -raw sync_access_key_id
terraform -chdir=terraform output -raw sync_secret_access_key
```

Configure Remotely Save with:

```text
Endpoint: https://s3.<REGION>.amazonaws.com
Region:   <REGION>
Bucket:   <VAULT_BUCKET>
```

- Use virtual hosted-style access and bidirectional sync.
- Leave the remote prefix blank so both systems use the same vault root.
- Leave encryption disabled because the Lambda must read the Markdown.
- Keep config-directory sync disabled so plugin settings and credentials do not enter S3.
- Run Check Connectivity, then sync. `+Inbox/welcome.md` and `System/schema.md` should appear.

Never include access keys, passwords, static bearer tokens, or Terraform state in screenshots, logs, issues, or chat messages.

## Security and limitations

- This template is single-user. It has no tenant isolation or shared administration model.
- The S3 bucket is private, encrypted at rest with S3-managed AES-256 encryption, and versioned. Noncurrent versions expire after 30 days.
- OAuth protects MCP calls. OAuth discovery and dynamic client registration are public because clients need them before login.
- Dynamic registration accepts only HTTPS callbacks on the configured ChatGPT, OpenAI, Claude, and Anthropic hosts, plus localhost callbacks. The callback list is capped, but the public registration route can still consume its finite slots.
- The static bearer grants the same vault access as an authenticated client. Rotate it if exposed.
- `terraform/terraform.tfstate` contains the static bearer, Obsidian sync credentials, and the generated Cognito bootstrap password. Store an encrypted backup privately. Losing the state can make the stack difficult to manage or destroy cleanly.
- Notes returned through MCP are sent to the AI client you selected. Review that provider's data handling before putting sensitive material in the vault.
- The MCP server works with Markdown only. It does not index attachments or Obsidian plugin data.
- Search and graph checks are bounded for Lambda safety. A large vault may require narrower folder prefixes or separate passes.
- S3 version history is recovery, not a complete backup strategy. Keep an independent encrypted backup for important notes.

Use `trash_note` for routine cleanup. Reserve `delete_note` for an exact path you intend to remove, and recover from S3 version history before the 30-day noncurrent-version window closes.

## Configuration reference

Set these values in `terraform/terraform.tfvars`:

| Variable | Default | Purpose |
| --- | --- | --- |
| `project_name` | required | Lowercase resource-name prefix, 3 to 40 characters. |
| `profile` | required | AWS CLI profile Terraform uses. |
| `owner_email` | required | Email for the single Cognito owner. |
| `region` | required | AWS region for every resource in the stack. |
| `vault_tz` | `UTC` | IANA time zone used for note dates and listings. |
| `vault_bucket_name` | derived | Existing bucket name override. Leave empty for an account-specific name. |
| `sync_user_name` | derived | IAM sync user override. Leave empty for a project-specific name. |
| `oauth_callback_port` | `9000` | Loopback callback port used by CLI MCP clients. |

## Troubleshooting

**The client shows old or missing tools.** Disconnect and reconnect the MCP server. Claude Code users can also run `claude mcp list` to check its state.

**The endpoint returns 401.** Complete OAuth login again because Cognito access tokens expire. For a script, confirm its bearer matches `terraform -chdir=terraform output -raw mcp_bearer_token` without printing that value into shared logs.

**The vault appears empty.** Confirm that deployment seeded the starter notes. If you use Obsidian, run Remotely Save and verify that `.md` objects exist in the configured bucket.

**Cognito sign-in fails.** Run the permanent-password command in step 4 and verify its profile, region, pool ID, and email.

**A client cannot register its callback.** Confirm that the callback uses HTTPS on an allowed client host, or localhost for a CLI client. If the callback limit is full, inspect the Cognito app client before removing stale URLs.

**Terraform uses the wrong account.** Stop and rerun `aws sts get-caller-identity --profile <PROFILE>`. Correct the profile before applying anything.

## Cost

AWS charges depend on region, account eligibility, usage, and current pricing. Personal use may fit within free allowances, but it is not guaranteed to be free. Review current prices for S3 storage and requests, Lambda, API Gateway, Cognito, and CloudWatch Logs before deployment. CloudWatch logs and noncurrent S3 versions have 30-day retention controls in this template.

## Tear down

Back up the vault first. Then use the S3 console to empty the vault bucket, including every object version and delete marker. Terraform deliberately cannot destroy a nonempty bucket.

```bash
terraform -chdir=terraform destroy
```

Keep `terraform.tfstate` until the destroy completes successfully.
