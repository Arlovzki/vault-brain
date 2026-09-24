# Vault Brain architecture

Vault Brain is a single-owner MCP server for Markdown notes stored in Amazon S3.
It gives compatible AI clients a controlled tool interface while keeping the vault
portable and readable without any AI provider.

## System context

```text
Compatible MCP client
        |
        | HTTPS, OAuth access token or static bearer
        v
Amazon API Gateway HTTP API
        |
        v
AWS Lambda: MCP server
        |                    |
        | note operations    | OAuth client management
        v                    v
Private, versioned S3     Amazon Cognito
        ^
        |
        | optional S3 sync
        |
Obsidian with Remotely Save
```

Each deployment creates one stack in one AWS account for one vault owner. There
is no shared application service or tenant database.

## Components

| Component | Responsibility |
| --- | --- |
| API Gateway | Exposes OAuth discovery, dynamic client registration, and the MCP endpoint over HTTPS. |
| Lambda | Implements JSON-RPC, authentication, tool discovery, validation, and note operations. |
| Amazon S3 | Stores the Markdown vault. Versioning retains replaced and deleted object versions for 30 days. |
| Amazon Cognito | Provides the owner account, hosted sign-in, OAuth authorization code flow, and PKCE support. |
| Sync IAM user | Gives the optional Obsidian sync plugin access to only the vault bucket. |
| Terraform | Creates the stack and stores deployment state locally. |

## How an AI client chooses a tool

During MCP initialization, the client calls `tools/list`. The server returns each
tool's name, description, and JSON input schema. The model compares that metadata
with the user's request, then sends a `tools/call` request for the selected tool.
Tool selection is not based on a hidden provider-specific command or prompt.

For example, a request to save a quick thought should match `capture`, while a
request to find text inside notes should match `search_vault`. The server still
validates every argument and authorization token before touching S3.

The tool surface has four groups:

- Discovery: `describe_schema`, `list_inbox`, and `list_notes`
- Reading: `read_note` and `search_vault`
- Writing: `capture`, `edit_note`, and `write_note`
- Organization: `move_note`, `trash_note`, `delete_note`, and `find_orphans`

`System/schema.md` is the canonical vault convention document. The
`describe_schema` tool reads it so a new client can learn the same rules. The
server reserves the `System/` namespace from tool-driven mutation so those rules
remain owner-controlled.

## Request and authentication flow

1. The client reads the public OAuth discovery metadata.
2. A remote client can register an approved callback through the RFC 7591 bridge.
3. Cognito signs the owner in and issues an access token through authorization
   code flow with PKCE.
4. The client sends JSON-RPC requests to `/mcp` with the access token.
5. Lambda verifies the token, validates the tool call, performs the S3 operation,
   and returns a JSON-RPC response.

A static bearer token is also available for the bundled smoke test and clients
that cannot complete OAuth. It grants the same vault access as an OAuth access
token and must be protected accordingly.

Dynamic client registration updates a single Cognito app client. It does not
create users or isolated tenants. Callback URLs are restricted by the server,
and API Gateway throttling provides an account-level traffic backstop.

## Data model and recovery

Each note is one UTF-8 Markdown object whose S3 key is its vault-relative path.
Folders are key prefixes rather than separate records. The starter vault uses:

- `+Inbox/` for untriaged captures
- `Notes/` for durable notes in the owner's words
- `Sources/` for external references
- `System/` for vault conventions
- `.trash/` for soft-deleted notes

S3 versioning is the recovery layer for overwritten and permanently deleted
objects. Noncurrent versions expire after 30 days. Soft deletion is still the
preferred everyday path because recovery from `.trash/` does not require AWS
console or CLI access.

Obsidian is an optional local view and editor. Remotely Save reads and writes the
same S3 bucket, so MCP clients and Obsidian converge on the same Markdown files.

## Deployment and state

`scripts/deploy.sh` performs the deployment in this order:

1. Install dependencies and build the Lambda bundle.
2. Initialize and apply Terraform.
3. Seed `vault-starter/` only when the bucket has no Markdown notes.
4. Print the MCP endpoint, sign-in details, and optional sync configuration.

Terraform state is intentionally local for this personal stack. The state file
contains sensitive values, including the static bearer token, sync access key,
and Cognito bootstrap password. Store it securely, exclude it from version
control, and include it in an encrypted backup.

## Trust boundaries and limitations

- An authorized MCP client can read and modify vault content. Only connect
  clients you trust with that access.
- Note content sent through a client is also subject to that client's data
  handling and retention policies.
- The static bearer token is long-lived until rotated. Prefer OAuth for
  interactive clients.
- The dynamic registration endpoint is public by design, but callback validation,
  registration limits, and API throttling reduce its attack surface.
- This is a single-user template. It does not provide tenant isolation, shared
  roles, or per-note permissions.
- Attachments can remain in S3 for Obsidian, but the MCP note tools operate on
  Markdown content.

## Repository map

```text
mcp-server/       TypeScript Lambda and MCP tool implementation
terraform/        AWS infrastructure and configuration variables
vault-starter/    Seed Markdown files
scripts/          Deployment and smoke-test helpers
docs/             Public design and architecture notes
```
