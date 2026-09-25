# Vault Brain

Vault Brain is a self-hosted MCP server for Markdown notes stored in Amazon S3. It gives compatible AI clients authenticated tools to search, read, create, edit, move, and remove notes without giving those clients direct S3 credentials.

Each deployment is a single-user stack in that person's AWS account. The live workshop also connects Obsidian through Remotely Save so participants can inspect and edit the same Markdown vault.

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
          live workshop step
```

The client discovers each tool's name, description, and input schema from the MCP server. The model normally chooses a tool from that metadata and supplies its arguments, so users do not need to mention tool names in ordinary prompts. The server validates the request, performs the S3 operation, and returns the result.

OAuth uses Cognito's authorization-code flow with PKCE S256. S256 is the SHA-256 transform used to prove that the client which started a login is the client completing it. It is not a public key. A small RFC 7591 registration bridge lets supported remote MCP clients register an approved callback URL. A generated static bearer token is also available for scripts and the smoke test.

Terraform manages the AWS resources and stores its sensitive state in a separate private S3 bucket. That state bucket is versioned, encrypted, blocked from public access, and protected by S3-native locking. S3 also stores the Markdown vault in a different bucket, while Cognito stores login state and registered callback URLs.

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

- Git
- AWS CLI configured with a personal AWS account and named profile
- Terraform 1.10 or newer
- Node.js 22 and npm
- AWS permissions to manage IAM, S3, Lambda, API Gateway, Cognito, and CloudWatch Logs
- At least one MCP-capable client, such as ChatGPT or Claude Code
- Obsidian and the Remotely Save community plugin for the live workshop's two-way sync activity

The workshop runner is written in Node.js. The same `npm run` commands work in
Windows PowerShell, Windows Command Prompt, macOS, and Linux. Bash, `curl`, and
other Unix-only command-line tools are not required.

## 1. Clone and run the preflight checks

```bash
git clone https://github.com/Arlovzki/vault-brain.git
cd vault-brain
npm run preflight -- --fix --profile workshop --client claude
```

Replace `workshop` with the name of your AWS CLI profile. If ChatGPT is your
workshop client, use:

```bash
npm run preflight -- --fix --profile workshop --client chatgpt
```

Preflight detects the operating system and checks Git, Node.js, npm, AWS CLI,
Terraform, the repository files, local dependencies, Terraform providers,
the stack configuration, the selected AWS identity, and the chosen MCP client.
It reports each item as `PASS`, `CHECK`, or `FAIL` and ends with either `READY`
or `BLOCKED`.

The options have narrow purposes:

- `--fix` installs the locked MCP server dependencies with `npm ci` and downloads
  Terraform providers without connecting a backend. It does not install system
  software, change AWS settings, create a bucket, or deploy anything.
- `--profile workshop` selects the named AWS profile for this check. Before the
  configuration file exists, it lets preflight show the account ID and ARN that
  the profile resolves to. It does not save or guess a profile.
- `--client claude` verifies that the Claude Code command is installed.
  `--client chatgpt` gives the manual check for ChatGPT Developer mode and
  Plugins because browser account access cannot be verified from the terminal.

Read the displayed AWS account ID and ARN. Do not continue unless they belong
to the personal account you intend to use.

## 2. Configure the stack

```bash
npm run configure
```

This creates `terraform/terraform.tfvars` from the tracked example. If the file
already exists, the command keeps it unchanged.

Edit `terraform/terraform.tfvars`:

```hcl
project_name = "vault-brain-yourname"
profile      = "default"
owner_email  = "you@example.com"
region       = "us-east-1"
vault_tz     = "UTC"
```

Use a unique, lowercase `project_name` because it becomes part of globally unique S3 and Cognito names. Pick the AWS region intentionally. `terraform.tfvars` and generated backend configuration are local files and must not be committed. Terraform state is sensitive and belongs in the protected remote backend created in the next step.

Save the AWS profile you verified in `profile`, then rerun preflight. The deploy
command reads the profile from this file and does not accept an override.

```bash
npm run preflight -- --client claude
```

Use `--client chatgpt` instead when that is your chosen client. This second run
should end with `READY`, followed by `Next: npm run bootstrap-state`.

## 3. Create the remote state backend

```bash
npm run bootstrap-state
```

This is the first command that creates an AWS resource. The runner shows the
derived state bucket, region, AWS account ID, and active identity. Type the exact
account ID. When a saved plan is shown, review it and type `APPLY` only when all
of those values are correct.

The state bucket is separate from the Markdown vault. It has versioning,
S3-managed AES-256 encryption, Bucket Owner Enforced ownership, all four Block
Public Access settings, a TLS-only bucket policy, and `prevent_destroy`
protection. Terraform 1.10 or newer uses an S3 `.tflock` object so concurrent
runs cannot write state at the same time. No DynamoDB table is needed.

The runner asks for `MIGRATE` before moving local state, then leaves Terraform's
own migration confirmation enabled so a newly-created destination cannot be
silently overwritten. It migrates the bootstrap configuration's own state to
`bootstrap/terraform.tfstate`, then initializes the main stack at
`main/terraform.tfstate`. Generated `.tfbackend` files contain bucket, key,
region, profile name, encryption, locking, and the verified account ID. A second
ignored generated file binds the AWS provider to that same account for plans,
applies, and teardown. Neither file contains AWS access keys, secret keys, or
session tokens.

After verifying that the complete state payload matches the S3 copy, the runner
renames local source and backup files as ignored migration-recovery copies.
Terraform can rewrite lineage and serial during this copy. If the process stops
after copying, rerun bootstrap-state: it compares the backup with S3 and asks
for an explicit `RECONNECT` before using the remote state. Move recovery copies
into encrypted storage or delete them after independently confirming the remote
state. They must never be committed.

Continue only when the command prints `STATE BACKEND READY`. Rerunning the same
command reconnects a matching checkout. It stops instead of guessing when a
bucket is inaccessible, belongs to another owner, or has conflicting state.

## 4. Build and deploy

```bash
npm run deploy
```

The runner is deliberately interactive and does not support automatic approval.
It performs the deployment in this order:

1. Installs the locked dependencies, reconnects and verifies the S3 backend,
   checks that a missing current state has no prior version or delete marker,
   builds the Lambda, and reruns strict preflight checks.
2. Shows the project, region, AWS account ID, and AWS identity.
3. Requires you to type the exact 12-digit AWS account ID.
4. Creates and displays a saved Terraform plan for review.
5. Verifies that the saved plan targets the confirmed AWS account, profile, and
   region, then requires you to type `APPLY`.
6. Verifies that the live AWS identity has not changed, then applies that exact
   saved plan.
7. Seeds the starter Markdown only when the current bucket listing contains no
   Markdown, including `.trash/`. If any Markdown exists, it leaves the vault
   unchanged. Non-Markdown objects do not block the starter seed.
8. Asks for the permanent Cognito password twice with hidden input. The password
   is sent directly to Cognito and is not printed or placed in shell history.
9. Prints the MCP endpoint and the settings needed for the remaining steps.

Use at least 12 printable ASCII characters with lowercase letters, uppercase
letters, and numbers. Terraform creates a generated bootstrap password in
remote state, so keep access to the state bucket tightly scoped.

If the AWS resources deploy but the password step fails, retry only that private
step:

```bash
npm run set-password
```

Do not run `npm run set-password` as a routine extra step after a successful
deployment. It exists only to recover from a failed or interrupted password
prompt.

## 5. Run the smoke test

```bash
npm run smoke
```

The cross-platform smoke test uses Node.js `fetch` and JSON parsing, so it does
not depend on `curl`, `grep`, or other shell utilities. It reads the endpoint and
static bearer from Terraform outputs, verifies the exact 12-tool contract,
performs a temporary capture and read, moves the note to trash, removes that
temporary note, rejects an unauthenticated request, and checks public OAuth
discovery. If cleanup cannot finish, it reports the exact area to inspect before
you rerun it. If the capture response times out before returning its path, the
runner prints the unique marker to search for in `+Inbox/`.

## 6. Connect an MCP client

Use the endpoint printed by `npm run deploy`. It must include the final `/mcp`
path. Complete the Cognito sign-in when the client opens a browser.

### Claude Code

Claude Code's [MCP guide](https://code.claude.com/docs/en/mcp) documents remote HTTP servers, OAuth login, and fixed callback ports. Add Vault Brain at user scope:

```bash
claude mcp add --transport http --scope user --callback-port 9000 vault-brain YOUR_MCP_URL
claude mcp login vault-brain
claude mcp list
```

The final command should show `vault-brain` as connected.

### ChatGPT

OpenAI's current [MCP connection guide](https://developers.openai.com/plugins/deploy/connect-chatgpt) documents this developer-mode flow:

1. Open ChatGPT Plugins and choose Add, then Create MCP App. If Add is not
   available, check Settings, Security and login for Developer mode. The control
   can depend on the account or workspace policy.
2. Name it `Vault Brain`. Select Server URL under Connection, paste the public
   endpoint including `/mcp`, and choose OAuth authentication.
3. Read the custom-server warning, acknowledge it only for your own endpoint,
   and create the connection.
4. Complete the Cognito sign-in, review the discovered tools, and add Vault Brain
   to a new conversation.

Product labels can move over time, but the connection still needs the public HTTPS MCP endpoint and browser-based OAuth login.

Test either client with:

> Before changing anything, read this vault's rules and tell me what each top-level folder is for.

The answer should be grounded in `System/schema.md`.

## 7. Sync the vault to Obsidian

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
- The remote `main/terraform.tfstate` object contains the static bearer, Obsidian sync credentials, and the generated Cognito bootstrap password. Restrict state-bucket access. Terraform's `sensitive` flag hides values from normal output but does not remove them from state.
- The state bucket is not the Markdown vault. The MCP Lambda and Obsidian sync user have no access to it, and normal application teardown does not delete it.
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

**Cognito sign-in fails.** If deployment reported that its password step failed,
run `npm run set-password`. It reads the profile, region, user pool, and owner
email from the saved configuration and Terraform outputs.

**A client cannot register its callback.** Confirm that the callback uses HTTPS on an allowed client host, or localhost for a CLI client. If the callback limit is full, inspect the Cognito app client before removing stale URLs.

**Terraform uses the wrong account.** Stop and correct `profile` in
`terraform/terraform.tfvars`. Run `npm run preflight` again and verify the
displayed account ID. Deployment also requires that exact ID before planning can
continue.

**The state bucket is inaccessible.** Do not create a replacement with the same
configuration and do not treat `403 AccessDenied` as a missing bucket. Confirm
the profile, account, region, and S3 permissions, then rerun
`npm run bootstrap-state`.

**The current state object is missing but history exists.** Stop. A delete marker
can make versioned state look empty even when recoverable versions remain. Restore
the intended exact S3 version before rerunning the state bootstrap. The runner
never plans against an apparently empty state object that has prior history.

**Terraform reports a state lock.** Confirm that no other Terraform process is
running. Never bypass the protection with `-lock=false`. Only use
`terraform force-unlock` for your own stale lock after you have verified that no
plan or apply is active.

**You moved to another computer.** Clone the repository, recreate the same
`terraform.tfvars`, run preflight, then run `npm run bootstrap-state`. The runner
reconnects to the existing verified backend before any plan or apply.

## Cost

AWS charges depend on region, account eligibility, usage, and current pricing. Personal use may fit within free allowances, but it is not guaranteed to be free. Review current prices for both S3 buckets and their requests, Lambda, API Gateway, Cognito, and CloudWatch Logs before deployment. CloudWatch logs and old vault-object versions have 30-day retention controls. Old state-object versions are retained unless you deliberately add a lifecycle policy later.

## Tear down

Back up the vault first. Then use the S3 console to empty the Markdown vault bucket, including every object version and delete marker. Terraform deliberately cannot destroy a nonempty vault bucket. Keep the state bucket in place while Terraform destroys the application stack.

```bash
terraform -chdir=terraform plan -destroy -out=destroy.tfplan
terraform -chdir=terraform apply destroy.tfplan
```

The saved plan can contain sensitive values. It is ignored by Git. Delete the
exact `terraform/destroy.tfplan` file after the apply finishes.

The normal destroy removes application resources only. Keep the protected state
bucket afterward so the final state and recovery history remain available.
Backend deletion is intentionally outside this guide. Both the bootstrap and
application state objects live in that bucket, and every protection resource has
`prevent_destroy`. Keep it unless you have designed and verified a separate state
migration and decommissioning runbook.
