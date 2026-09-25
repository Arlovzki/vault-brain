import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  assertDefaultWorkspaceOnly,
  classifyAwsLookupError,
  migrationDecision,
  parseOptions,
  parseTfvars,
  parseVersion,
  plannedIdentityFromJson,
  recoveryLocalStateText,
  renderBackendConfig,
  renderExpectedAccountConfig,
  resolveCommand,
  s3ListingHasMarkdown,
  sameStatePayload,
  stateHistoryHasKey,
  stateBucketName,
  validSmokeKey,
  validTrashKey,
  validateConfig,
  validateToolNames,
  versionAtLeast,
} from "./workshop.mjs";

test("state migration accepts only the default workspace", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "vault-brain-workspace-test-"));
  try {
    assert.doesNotThrow(() => assertDefaultWorkspaceOnly(root, "Test"));
    mkdirSync(path.join(root, ".terraform"), { recursive: true });
    writeFileSync(path.join(root, ".terraform", "environment"), "staging\n");
    assert.throws(() => assertDefaultWorkspaceOnly(root, "Test"), /supports only the default workspace/);
    writeFileSync(path.join(root, ".terraform", "environment"), "default\n");
    mkdirSync(path.join(root, "terraform.tfstate.d", "staging"), { recursive: true });
    assert.throws(() => assertDefaultWorkspaceOnly(root, "Test"), /non-default local workspace state/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("version parsing enforces the documented minimums", () => {
  assert.deepEqual(parseVersion("Terraform v1.10.2"), [1, 10, 2]);
  assert.equal(versionAtLeast("1.10.0", "1.10.0"), true);
  assert.equal(versionAtLeast("1.15.8", "1.10.0"), true);
  assert.equal(versionAtLeast("1.9.8", "1.10.0"), false);
  assert.equal(versionAtLeast("22.0.0", "22.0.0"), true);
});

test("web clients are preflight choices and Claude Code remains explicit", () => {
  for (const client of ["claude", "claude-web", "chatgpt", "claude-code"]) {
    assert.equal(parseOptions(["--client", client]).client, client);
  }
  assert.equal(parseOptions([]).client, "");
  assert.throws(() => parseOptions(["--client", "unknown"]), /claude-web, chatgpt, or claude-code/);
});

test("state backend names and configuration are deterministic and bounded", () => {
  const bucket = stateBucketName("a".repeat(40), "123456789012");
  assert.equal(bucket, `${"a".repeat(40)}-tfstate-123456789012`);
  assert.equal(bucket.length, 61);
  const config = renderBackendConfig({
    bucket,
    key: "main/terraform.tfstate",
    region: "ap-southeast-1",
    profile: "personal",
    accountId: "123456789012",
  });
  assert.match(config, /use_lockfile\s+= true/);
  assert.match(config, /encrypt\s+= true/);
  assert.match(config, /allowed_account_ids = \["123456789012"\]/);
  assert.doesNotMatch(config, /access_key|secret_key/i);
  assert.equal(renderExpectedAccountConfig("123456789012"), '{\n  "expected_account_id": "123456789012"\n}\n');
  assert.throws(() => renderExpectedAccountConfig("123"), /exactly 12 digits/);
});

test("state migration decisions fail closed on conflicts and orphaned buckets", () => {
  assert.equal(migrationDecision({ localState: false, remoteState: false, bucketExists: false }), "create");
  assert.equal(migrationDecision({ localState: true, remoteState: false, bucketExists: true }), "migrate");
  assert.equal(migrationDecision({ localState: false, remoteState: true, bucketExists: true }), "remote");
  assert.equal(migrationDecision({ localState: true, remoteState: true, bucketExists: true }), "conflict");
  assert.equal(migrationDecision({ localState: false, remoteState: false, bucketExists: true }), "orphaned");
});

test("state migration accepts rewritten identity only when the full payload matches", () => {
  const source = {
    version: 4,
    terraform_version: "1.15.8",
    lineage: "original-lineage",
    serial: 9,
    outputs: { state_bucket: { value: "demo-tfstate", type: "string" } },
    resources: [{ type: "aws_s3_bucket", name: "terraform_state", instances: [{ attributes: { id: "demo-tfstate" } }] }],
    check_results: [],
  };
  const migrated = { ...source, lineage: "new-lineage", serial: 1 };
  const sourceText = JSON.stringify(source);
  assert.equal(sameStatePayload(sourceText, JSON.stringify(migrated)), true);
  assert.equal(sameStatePayload(sourceText, JSON.stringify({ ...migrated, resources: [] })), false);
  assert.equal(sameStatePayload(sourceText, JSON.stringify({ ...migrated, outputs: {} })), false);
  assert.equal(sameStatePayload(sourceText, JSON.stringify({ ...migrated, check_results: ["changed"] })), false);
});

test("interrupted migration reads only a valid backup behind an empty active state", () => {
  const valid = JSON.stringify({ lineage: "original-lineage", serial: 9, resources: [] });
  assert.equal(recoveryLocalStateText("", valid), valid);
  assert.equal(recoveryLocalStateText(valid), valid);
  assert.throws(() => recoveryLocalStateText("", null), /migration backup is missing/);
  assert.throws(() => recoveryLocalStateText("", "not-json"), /migration backup.*unreadable/);
  assert.throws(() => recoveryLocalStateText("not-json", valid), /Local Terraform state is unreadable/);
});

test("S3 lookup errors never treat access denial as a missing bucket", () => {
  assert.equal(classifyAwsLookupError("An error occurred (404) when calling HeadBucket"), "missing");
  assert.equal(classifyAwsLookupError("An error occurred (403) when calling HeadBucket"), "inaccessible");
  assert.equal(classifyAwsLookupError("AccessDenied"), "inaccessible");
  assert.equal(classifyAwsLookupError("connection timed out"), "error");
});

test("state history detects exact versions and delete markers", () => {
  const listing = JSON.stringify({
    Versions: [{ Key: "main/terraform.tfstate.tflock" }],
    DeleteMarkers: [{ Key: "main/terraform.tfstate" }],
  });
  assert.equal(stateHistoryHasKey(listing, "main/terraform.tfstate"), true);
  assert.equal(stateHistoryHasKey(listing, "bootstrap/terraform.tfstate"), false);
  assert.throws(() => stateHistoryHasKey("not-json", "main/terraform.tfstate"), /unreadable S3 version history/);
});

test("npm uses its JavaScript entry point when the runner was started by npm", () => {
  assert.deepEqual(
    resolveCommand("npm", ["ci"], "win32", { npm_execpath: "C:\\npm\\npm-cli.js" }, "C:\\node\\node.exe"),
    { command: "C:\\node\\node.exe", args: ["C:\\npm\\npm-cli.js", "ci"] },
  );
  assert.throws(
    () => resolveCommand("npm", ["--version"], "win32", {}, "node.exe"),
    /Start this command with npm run/,
  );
  assert.deepEqual(resolveCommand("terraform", ["version"], "win32", {}, "node.exe"), {
    command: "terraform",
    args: ["version"],
  });
});

test("saved Terraform plan identity is complete and explicit", () => {
  const plan = JSON.stringify({
    planned_values: {
      outputs: {
        aws_account_id: { value: "123456789012" },
        aws_profile: { value: "workshop" },
        region: { value: "ap-southeast-1" },
      },
    },
  });
  assert.deepEqual(plannedIdentityFromJson(plan), {
    accountId: "123456789012",
    profile: "workshop",
    region: "ap-southeast-1",
  });
  assert.throws(() => plannedIdentityFromJson("{}"), /complete AWS identity/);
});

test("tfvars parser accepts CRLF, comments, strings, and the callback port", () => {
  const config = parseTfvars([
    "# workshop stack\r",
    'project_name = "vault-brain-alex"\r',
    'profile = "personal"\r',
    'owner_email = "alex@example.org"\r',
    'region = "ap-southeast-1"\r',
    'vault_tz = "Asia/Manila" # local dates\r',
    "oauth_callback_port = 9000\r",
  ].join("\n"));
  assert.deepEqual(config, {
    project_name: "vault-brain-alex",
    profile: "personal",
    owner_email: "alex@example.org",
    region: "ap-southeast-1",
    vault_tz: "Asia/Manila",
    oauth_callback_port: 9000,
  });
  assert.deepEqual(validateConfig(config), []);
});

test("tfvars parser rejects duplicate workshop values", () => {
  assert.throws(
    () => parseTfvars('profile = "one"\nprofile = "two"\n'),
    /appears more than once/,
  );
});

test("config validation rejects placeholders and unsafe project names", () => {
  const errors = validateConfig({
    project_name: "Vault Brain",
    profile: "default",
    owner_email: "you@example.com",
    region: "somewhere",
    vault_tz: "Not/AZone",
    oauth_callback_port: 70000,
  });
  assert.equal(errors.length, 5);
});

test("any Markdown object means the vault has already been used", () => {
  assert.equal(s3ListingHasMarkdown(""), false);
  assert.equal(s3ListingHasMarkdown("2026-01-01 00:00:00 12 image.png"), false);
  assert.equal(s3ListingHasMarkdown("2026-01-01 00:00:00 12 +Inbox/note.md"), true);
  assert.equal(s3ListingHasMarkdown("2026-01-01 00:00:00 12 .trash/old note.md"), true);
});

test("tool validation requires the exact unique 12-tool contract", () => {
  const expected = [
    "describe_schema",
    "capture",
    "list_inbox",
    "list_notes",
    "read_note",
    "search_vault",
    "edit_note",
    "write_note",
    "move_note",
    "trash_note",
    "delete_note",
    "find_orphans",
  ];
  assert.equal(validateToolNames(expected), true);
  assert.equal(validateToolNames(expected.slice(1)), false);
  assert.equal(validateToolNames([...expected, "unexpected"]), false);
  assert.equal(validateToolNames([...expected, "capture"]), false);
});

test("smoke cleanup accepts only exact inbox Markdown paths", () => {
  assert.equal(validSmokeKey("+Inbox/2026-09-24-vault-brain-smoke.md"), true);
  assert.equal(validSmokeKey("Notes/real-note.md"), false);
  assert.equal(validSmokeKey("+Inbox/../System/schema.md"), false);
  assert.equal(validSmokeKey("+Inbox\\note.md"), false);
  assert.equal(validSmokeKey("+Inbox/note.txt"), false);
  assert.equal(validTrashKey(".trash/2026-09-24-note.md"), true);
  assert.equal(validTrashKey(".trash/../System/schema.md"), false);
  assert.equal(validTrashKey("+Inbox/note.md"), false);
});
