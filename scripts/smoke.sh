#!/usr/bin/env bash
# Smoke-test a deployed vault-brain stack over the static bearer token.
#
# Proves four things, in order: the endpoint speaks MCP, it exposes the tools it
# should, a note round-trips through S3, and auth is actually enforced. Reads the
# URL and token from Terraform outputs, so it needs no arguments after a deploy.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TF=(terraform -chdir="$ROOT/terraform")
EXPECTED_TOOLS=12

URL="$("${TF[@]}" output -raw mcp_connector_url)"
TOKEN="$("${TF[@]}" output -raw mcp_bearer_token)"
BASE="${URL%/mcp}"

AUTH_HEADER_FILE="$(mktemp "${TMPDIR:-/tmp}/vault-brain-smoke.XXXXXX")"
chmod 600 "$AUTH_HEADER_FILE"
cleanup() { rm -f "$AUTH_HEADER_FILE"; }
trap cleanup EXIT
printf 'authorization: Bearer %s\n' "$TOKEN" > "$AUTH_HEADER_FILE"
unset TOKEN

pass() { printf '\033[1;32mPASS\033[0m  %s\n' "$*"; }
fail() { printf '\033[1;31mFAIL\033[0m  %s\n' "$*"; exit 1; }

rpc() {
  curl -sS -X POST "$URL" \
    -H "@$AUTH_HEADER_FILE" \
    -H "content-type: application/json" \
    -d "$1"
}

echo "Endpoint: $URL"
echo

# 1. initialize
OUT="$(rpc '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}')"
echo "$OUT" | grep -q 'vault-brain-server' \
  && pass "initialize returns serverInfo vault-brain-server" \
  || fail "initialize did not return the expected serverInfo: $OUT"

# 2. tools/list
OUT="$(rpc '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}')"
COUNT="$(printf '%s' "$OUT" | grep -o '"name":"[a-z_]*"' | wc -l | tr -d ' ')"
[[ "$COUNT" == "$EXPECTED_TOOLS" ]] \
  && pass "tools/list returns $EXPECTED_TOOLS tools" \
  || fail "tools/list returned $COUNT tools, expected $EXPECTED_TOOLS: $OUT"

for t in describe_schema capture list_inbox list_notes read_note search_vault edit_note write_note move_note trash_note delete_note find_orphans; do
  printf '%s' "$OUT" | grep -q "\"name\":\"$t\"" || fail "tool missing from tools/list: $t"
done
pass "every expected tool is present by name"

# 3. capture, read, trash round-trip
STAMP="$(date +%s)"
OUT="$(rpc "{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"tools/call\",\"params\":{\"name\":\"capture\",\"arguments\":{\"text\":\"smoke test $STAMP\",\"title\":\"smoke test $STAMP\"}}}")"
KEY="$(printf '%s' "$OUT" | grep -o '+Inbox/[^"\\]*\.md' | head -1)"
[[ -n "$KEY" ]] && pass "capture wrote $KEY" || fail "capture did not report a key: $OUT"

OUT="$(rpc "{\"jsonrpc\":\"2.0\",\"id\":4,\"method\":\"tools/call\",\"params\":{\"name\":\"read_note\",\"arguments\":{\"path\":\"$KEY\"}}}")"
printf '%s' "$OUT" | grep -q "smoke test $STAMP" \
  && pass "read_note returns what capture wrote" \
  || fail "read_note did not return the captured text: $OUT"

OUT="$(rpc "{\"jsonrpc\":\"2.0\",\"id\":5,\"method\":\"tools/call\",\"params\":{\"name\":\"describe_schema\",\"arguments\":{}}}")"
printf '%s' "$OUT" | grep -q 'Vault schema' \
  && pass "describe_schema returns System/schema.md" \
  || fail "describe_schema did not return the schema note: $OUT"

OUT="$(rpc "{\"jsonrpc\":\"2.0\",\"id\":6,\"method\":\"tools/call\",\"params\":{\"name\":\"trash_note\",\"arguments\":{\"path\":\"$KEY\"}}}")"
printf '%s' "$OUT" | grep -q '\.trash/' \
  && pass "trash_note moved it into .trash/" \
  || fail "trash_note did not report a .trash/ destination: $OUT"

# 4. auth is enforced, and discovery is public
CODE="$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$URL" \
  -H "content-type: application/json" \
  -d '{"jsonrpc":"2.0","id":7,"method":"tools/list","params":{}}')"
[[ "$CODE" == "401" ]] \
  && pass "an unauthenticated call is rejected with 401" \
  || fail "expected 401 without a token, got $CODE"

CODE="$(curl -sS -o /dev/null -w '%{http_code}' "$BASE/.well-known/oauth-protected-resource")"
[[ "$CODE" == "200" ]] \
  && pass "OAuth discovery is public (200)" \
  || fail "expected 200 on /.well-known/oauth-protected-resource, got $CODE"

echo
printf '\033[1;32mAll smoke checks passed.\033[0m\n'
