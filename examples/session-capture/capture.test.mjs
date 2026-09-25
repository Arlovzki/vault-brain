import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, test } from "node:test";

const script = fileURLToPath(new URL("./capture.mjs", import.meta.url));
const temporary = [];

afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture() {
  const base = mkdtempSync(path.join(os.tmpdir(), "vault-capture-test-"));
  temporary.push(base);
  const vault = path.join(base, "vault");
  const allowedRoot = path.join(base, "example-app");
  mkdirSync(vault);
  mkdirSync(path.join(vault, "+Inbox"));
  mkdirSync(allowedRoot);
  mkdirSync(path.join(allowedRoot, "src"));
  return { base, vault, allowedRoot };
}

function run(paths, hook, options = {}) {
  return spawnSync(process.execPath, [
    script, "--client", options.client ?? "codex",
    "--vault", options.vault ?? paths.vault,
    "--allow-root", options.allowedRoot ?? paths.allowedRoot,
  ], {
    input: JSON.stringify(hook),
    encoding: "utf8",
    env: { ...process.env, VAULT_CAPTURE_INCLUDE_RESPONSE: "1" },
  });
}

function input(cwd) {
  return {
    hook_event_name: "Stop",
    session_id: "synthetic-session-1",
    cwd,
  last_assistant_message: "Private reply content must not enter the receipt.",
    transcript_path: "/private/secret/transcript.jsonl",
  };
}

test("metadata-only receipt follows the starter schema and ignores reply and transcript fields", () => {
  const paths = fixture();
  const result = run(paths, input(path.join(paths.allowedRoot, "src")));
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "");
  const files = readdirSync(path.join(paths.vault, "+Inbox"));
  assert.equal(files.length, 1);
  assert.match(files[0], /^\d{4}-\d{2}-\d{2}-session-codex-example-app-[a-f0-9]{12}\.md$/);
  const note = readFileSync(path.join(paths.vault, "+Inbox", files[0]), "utf8");
  assert.match(note, /^---\ntype: capture\n/);
  assert.match(note, /# Codex session in example-app/);
  assert.doesNotMatch(note, /Private reply content|transcript\.jsonl|Last assistant reply/);
});

test("later Stops leave a manually edited receipt byte-for-byte unchanged", () => {
  const paths = fixture();
  run(paths, input(paths.allowedRoot), { client: "claude-code" });
  const inbox = path.join(paths.vault, "+Inbox");
  const filename = readdirSync(inbox)[0];
  const notePath = path.join(inbox, filename);
  const edited = `${readFileSync(notePath, "utf8").replace(/\n/g, "\r\n")}\r\nMy hand-written decision.\r\n`;
  writeFileSync(notePath, edited);
  const result = run(paths, { ...input(paths.allowedRoot), last_assistant_message: "Another response" }, { client: "claude-code" });
  assert.equal(result.status, 0);
  assert.deepEqual(readdirSync(inbox), [filename]);
  assert.equal(readFileSync(notePath, "utf8"), edited);
});

test("only cwd inside the approved project root can create a receipt", () => {
  const paths = fixture();
  const outside = path.join(paths.base, "other-project");
  mkdirSync(outside);
  const result = run(paths, input(outside));
  assert.equal(result.status, 0);
  assert.deepEqual(readdirSync(path.join(paths.vault, "+Inbox")), []);
  const inside = run(paths, input(path.join(paths.allowedRoot, "src")));
  assert.equal(inside.status, 0);
  assert.equal(readdirSync(path.join(paths.vault, "+Inbox")).length, 1);
});

test("filesystem root and home directory cannot be allow-root", () => {
  const paths = fixture();
  for (const allowedRoot of [path.parse(paths.allowedRoot).root, os.homedir()]) {
    const result = run(paths, input(paths.allowedRoot), { allowedRoot });
    assert.equal(result.status, 0);
    assert.deepEqual(readdirSync(path.join(paths.vault, "+Inbox")), []);
  }
});

test("a cwd symlink escaping the approved root is rejected", { skip: process.platform === "win32" }, () => {
  const paths = fixture();
  const outside = path.join(paths.base, "outside");
  mkdirSync(outside);
  const linked = path.join(paths.allowedRoot, "linked");
  symlinkSync(outside, linked, "dir");
  const result = run(paths, input(linked));
  assert.equal(result.status, 0);
  assert.deepEqual(readdirSync(path.join(paths.vault, "+Inbox")), []);
});

test("a planted inbox symlink cannot redirect receipt creation", { skip: process.platform === "win32" }, () => {
  const paths = fixture();
  run(paths, input(paths.allowedRoot));
  const inbox = path.join(paths.vault, "+Inbox");
  const notePath = path.join(inbox, readdirSync(inbox)[0]);
  const outside = path.join(paths.base, "outside.md");
  writeFileSync(outside, "keep me");
  rmSync(notePath);
  symlinkSync(outside, notePath);
  const result = run(paths, input(paths.allowedRoot));
  assert.equal(result.status, 0);
  assert.equal(readFileSync(outside, "utf8"), "keep me");
});
