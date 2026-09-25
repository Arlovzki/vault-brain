#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(SCRIPT_DIR, "..");
const MCP_DIR = path.join(ROOT, "mcp-server");
const TF_DIR = path.join(ROOT, "terraform");
const STATE_TF_DIR = path.join(ROOT, "state-bootstrap");
const TFVARS = path.join(TF_DIR, "terraform.tfvars");
const TFVARS_EXAMPLE = path.join(TF_DIR, "terraform.tfvars.example");
const MAIN_BACKEND_CONFIG = path.join(TF_DIR, "backend.s3.tfbackend");
const MAIN_ACCOUNT_CONFIG = path.join(TF_DIR, "backend.auto.tfvars.json");
const BOOTSTRAP_BACKEND_CONFIG = path.join(STATE_TF_DIR, "backend.s3.tfbackend");
const BOOTSTRAP_BACKEND_FILE = path.join(STATE_TF_DIR, "backend.generated.tf");
const MAIN_STATE_KEY = "main/terraform.tfstate";
const BOOTSTRAP_STATE_KEY = "bootstrap/terraform.tfstate";
const EXPECTED_TOOLS = [
  "capture",
  "delete_note",
  "describe_schema",
  "edit_note",
  "find_orphans",
  "list_inbox",
  "list_notes",
  "move_note",
  "read_note",
  "search_vault",
  "trash_note",
  "write_note",
].sort();

const colorEnabled = Boolean(process.stdout.isTTY && !process.env.NO_COLOR);
const colors = {
  cyan: (value) => colorEnabled ? `\u001b[36m${value}\u001b[0m` : value,
  green: (value) => colorEnabled ? `\u001b[32m${value}\u001b[0m` : value,
  red: (value) => colorEnabled ? `\u001b[31m${value}\u001b[0m` : value,
  yellow: (value) => colorEnabled ? `\u001b[33m${value}\u001b[0m` : value,
};

class CliError extends Error {
  constructor(message, exitCode = 1) {
    super(message);
    this.name = "CliError";
    this.exitCode = exitCode;
  }
}

class CancelledError extends CliError {
  constructor() {
    super("Cancelled.", 130);
    this.name = "CancelledError";
  }
}

function line(label, message, color = (value) => value) {
  console.log(`${color(`[${label}]`)} ${message}`);
}

function banner(message) {
  console.log(`\n${colors.cyan(`==> ${message}`)}`);
}

export function resolveCommand(
  command,
  args,
  platform = process.platform,
  env = process.env,
  execPath = process.execPath,
) {
  if (command === "npm" && env.npm_execpath) {
    return { command: execPath, args: [env.npm_execpath, ...args] };
  }
  if (platform === "win32" && command === "npm") {
    throw new CliError("npm could not be launched safely. Start this command with npm run, as shown in the guide.");
  }
  return { command, args };
}

function run(command, args, options = {}) {
  const {
    cwd = ROOT,
    env = process.env,
    stdio = "pipe",
    acceptedExitCodes = [0],
    timeout = 0,
    maxBuffer = 8 * 1024 * 1024,
    sensitiveOutput = false,
  } = options;
  const resolved = resolveCommand(command, args, process.platform, env, process.execPath);
  const result = spawnSync(resolved.command, resolved.args, {
    cwd,
    env,
    encoding: "utf8",
    maxBuffer,
    shell: false,
    stdio,
    timeout: timeout || undefined,
    windowsHide: true,
  });

  if (result.error) {
    if (result.error.code === "ENOENT") {
      throw new CliError(`${command} was not found on PATH.`);
    }
    if (result.error.code === "ETIMEDOUT") {
      throw new CliError(`${command} timed out.`);
    }
    throw new CliError(`${command} could not start: ${result.error.message}`);
  }
  if (result.signal) throw new CliError(`${command} stopped after signal ${result.signal}.`);
  if (!acceptedExitCodes.includes(result.status ?? 1)) {
    const detail = sensitiveOutput
      ? ""
      : [result.stderr, result.stdout]
        .map((value) => String(value ?? "").trim())
        .find(Boolean);
    throw new CliError(detail ? `${command} failed: ${detail}` : `${command} failed.`);
  }
  return {
    status: result.status ?? 0,
    stdout: String(result.stdout ?? ""),
    stderr: String(result.stderr ?? ""),
  };
}

function tryRun(command, args, options = {}) {
  try {
    return { ok: true, ...run(command, args, options) };
  } catch (error) {
    return { ok: false, error };
  }
}

export function parseVersion(value) {
  const match = String(value).match(/(\d+)\.(\d+)(?:\.(\d+))?/);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)];
}

export function versionAtLeast(actual, minimum) {
  const left = Array.isArray(actual) ? actual : parseVersion(actual);
  const right = Array.isArray(minimum) ? minimum : parseVersion(minimum);
  if (!left || !right) return false;
  for (let index = 0; index < 3; index += 1) {
    if (left[index] > right[index]) return true;
    if (left[index] < right[index]) return false;
  }
  return true;
}

export function stateBucketName(projectName, accountId) {
  const bucket = `${projectName}-tfstate-${accountId}`;
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket) || bucket.length > 63) {
    throw new CliError("The derived Terraform state bucket name is not a valid S3 bucket name.");
  }
  return bucket;
}

export function renderBackendConfig({ bucket, key, region, profile, accountId }) {
  return [
    `bucket              = ${JSON.stringify(bucket)}`,
    `key                 = ${JSON.stringify(key)}`,
    `region              = ${JSON.stringify(region)}`,
    `profile             = ${JSON.stringify(profile)}`,
    "encrypt             = true",
    "use_lockfile        = true",
    `allowed_account_ids = [${JSON.stringify(accountId)}]`,
    "",
  ].join("\n");
}

export function renderExpectedAccountConfig(accountId) {
  if (!/^\d{12}$/.test(String(accountId))) throw new CliError("Expected AWS account ID must contain exactly 12 digits.");
  return `${JSON.stringify({ expected_account_id: String(accountId) }, null, 2)}\n`;
}

export function migrationDecision({ localState, remoteState, bucketExists }) {
  if (localState && remoteState) return "conflict";
  if (localState && bucketExists) return "migrate";
  if (remoteState) return "remote";
  if (bucketExists) return "orphaned";
  return "create";
}

export function classifyAwsLookupError(message) {
  const value = String(message);
  if (/\b404\b|NoSuchBucket|Not Found/i.test(value)) return "missing";
  if (/\b403\b|AccessDenied|Forbidden/i.test(value)) return "inaccessible";
  return "error";
}

export function stateHistoryHasKey(text, key) {
  let parsed;
  try {
    parsed = JSON.parse(String(text));
  } catch {
    throw new CliError("AWS returned unreadable S3 version history.");
  }
  return [...(parsed.Versions ?? []), ...(parsed.DeleteMarkers ?? [])]
    .some((entry) => entry?.Key === key);
}

function stateIdentity(text, source) {
  try {
    const parsed = JSON.parse(text);
    const lineage = String(parsed.lineage ?? "");
    const serial = Number(parsed.serial);
    if (!lineage || !Number.isInteger(serial) || serial < 0) throw new Error("missing identity");
    return { lineage, serial };
  } catch {
    throw new CliError(`${source} Terraform state is unreadable. Stop before migration.`);
  }
}

export function sameStatePayload(leftText, rightText) {
  stateIdentity(leftText, "Source");
  stateIdentity(rightText, "Destination");
  const left = JSON.parse(leftText);
  const right = JSON.parse(rightText);
  delete left.lineage;
  delete left.serial;
  delete right.lineage;
  delete right.serial;
  return isDeepStrictEqual(left, right);
}

export function recoveryLocalStateText(activeText, backupText = null) {
  if (activeText.length > 0) {
    stateIdentity(activeText, "Local");
    return activeText;
  }
  if (backupText === null) {
    throw new CliError("The local state is empty and its migration backup is missing. Stop and inspect both backends.");
  }
  stateIdentity(backupText, "Local migration backup");
  return backupText;
}

function writeGeneratedFile(filePath, content) {
  if (existsSync(filePath)) {
    const current = readFileSync(filePath, "utf8");
    if (current === content) return;
    throw new CliError(`Generated backend file ${filePath} does not match this configuration. Stop and verify the existing state location before changing it.`);
  }
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  try {
    writeFileSync(temporaryPath, content, { encoding: "utf8", mode: 0o600 });
    renameSync(temporaryPath, filePath);
  } finally {
    if (existsSync(temporaryPath)) rmSync(temporaryPath, { force: true });
  }
}

function readBackendMetadata(directory) {
  const metadataPath = path.join(directory, ".terraform", "terraform.tfstate");
  if (!existsSync(metadataPath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(metadataPath, "utf8"));
    return parsed?.backend ?? null;
  } catch {
    return null;
  }
}

export function assertDefaultWorkspaceOnly(directory, label) {
  const environmentFile = path.join(directory, ".terraform", "environment");
  const selected = String(process.env.TF_WORKSPACE || (existsSync(environmentFile) ? readFileSync(environmentFile, "utf8") : "default")).trim();
  if (selected && selected !== "default") {
    throw new CliError(`${label} uses Terraform workspace ${selected}. This workshop supports only the default workspace.`);
  }
  const workspaceDirectory = path.join(directory, "terraform.tfstate.d");
  if (existsSync(workspaceDirectory) && readdirSync(workspaceDirectory).length > 0) {
    throw new CliError(`${label} contains non-default local workspace state in ${workspaceDirectory}. Move or reconcile it before using this workshop runner.`);
  }
}

function expectedBackend(config, accountId, key = MAIN_STATE_KEY) {
  return {
    bucket: stateBucketName(config.project_name, accountId),
    key,
    region: config.region,
    profile: config.profile,
    accountId,
  };
}

function backendMatches(directory, expected) {
  const backend = readBackendMetadata(directory);
  const values = backend?.config;
  return backend?.type === "s3"
    && values?.bucket === expected.bucket
    && values?.key === expected.key
    && values?.region === expected.region
    && values?.profile === expected.profile
    && values?.encrypt === true
    && values?.use_lockfile === true
    && Array.isArray(values?.allowed_account_ids)
    && values.allowed_account_ids.length === 1
    && values.allowed_account_ids[0] === expected.accountId;
}

function expectedAccountMatches(accountId) {
  if (!existsSync(MAIN_ACCOUNT_CONFIG)) return false;
  try {
    const parsed = JSON.parse(readFileSync(MAIN_ACCOUNT_CONFIG, "utf8"));
    return parsed?.expected_account_id === accountId && Object.keys(parsed).length === 1;
  } catch {
    return false;
  }
}

function decodeHclString(raw, key) {
  try {
    return JSON.parse(`"${raw}"`);
  } catch {
    throw new CliError(`${key} must be a quoted string in terraform/terraform.tfvars.`);
  }
}

export function parseTfvars(text) {
  const knownStringKeys = new Set([
    "project_name",
    "profile",
    "owner_email",
    "region",
    "vault_tz",
    "vault_bucket_name",
    "sync_user_name",
  ]);
  const knownNumberKeys = new Set(["oauth_callback_port"]);
  const values = {};
  const seen = new Set();

  for (const originalLine of String(text).split(/\r?\n/)) {
    const trimmed = originalLine.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("//")) continue;

    const keyMatch = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    if (!keyMatch) continue;
    const key = keyMatch[1];
    if (!knownStringKeys.has(key) && !knownNumberKeys.has(key)) continue;
    if (seen.has(key)) throw new CliError(`${key} appears more than once in terraform/terraform.tfvars.`);
    seen.add(key);

    if (knownStringKeys.has(key)) {
      const match = trimmed.match(/^[A-Za-z_][A-Za-z0-9_]*\s*=\s*"((?:\\.|[^"\\])*)"\s*(?:#.*)?$/);
      if (!match) throw new CliError(`${key} must use one quoted literal value in terraform/terraform.tfvars.`);
      values[key] = decodeHclString(match[1], key);
    } else {
      const match = trimmed.match(/^[A-Za-z_][A-Za-z0-9_]*\s*=\s*(\d+)\s*(?:#.*)?$/);
      if (!match) throw new CliError(`${key} must use one integer literal in terraform/terraform.tfvars.`);
      values[key] = Number(match[1]);
    }
  }
  return values;
}

function loadConfig(required = true) {
  if (!existsSync(TFVARS)) {
    if (required) {
      throw new CliError("terraform/terraform.tfvars is missing. Run npm run configure, edit the file, then rerun preflight.");
    }
    return null;
  }
  return parseTfvars(readFileSync(TFVARS, "utf8"));
}

export function validateConfig(config) {
  const errors = [];
  const required = ["project_name", "profile", "owner_email", "region"];
  for (const key of required) {
    if (!String(config[key] ?? "").trim()) errors.push(`${key} is required`);
  }
  if (config.project_name && !/^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/.test(config.project_name)) {
    errors.push("project_name must be 3 to 40 lowercase letters, numbers, or hyphens and cannot start or end with a hyphen");
  }
  if (config.owner_email) {
    const email = String(config.owner_email);
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || /^(you|user)@example\.com$/i.test(email)) {
      errors.push("owner_email must be the attendee's real sign-in email, not an example address");
    }
  }
  if (config.region && !/^[a-z]{2}(?:-gov)?-[a-z]+-\d$/.test(String(config.region))) {
    errors.push("region does not look like an AWS region such as ap-southeast-1");
  }
  const timezone = String(config.vault_tz ?? "UTC");
  try {
    new Intl.DateTimeFormat("en", { timeZone: timezone }).format();
  } catch {
    errors.push("vault_tz must be a valid IANA time zone such as Asia/Manila");
  }
  const callbackPort = Number(config.oauth_callback_port ?? 9000);
  if (!Number.isInteger(callbackPort) || callbackPort < 1 || callbackPort > 65535) {
    errors.push("oauth_callback_port must be an integer from 1 to 65535");
  }
  return errors;
}

function platformLabel() {
  if (process.platform === "win32") return `Windows ${os.release()} (${process.arch})`;
  if (process.platform === "darwin") return `macOS ${os.release()} (${process.arch})`;
  const wsl = /microsoft/i.test(os.release()) || Boolean(process.env.WSL_DISTRO_NAME);
  return `${wsl ? "Windows via WSL" : "Linux"} ${os.release()} (${process.arch})`;
}

function commandVersion(command, args = ["--version"]) {
  if (process.platform === "win32" && command === "claude") {
    const located = tryRun("where.exe", [command], { timeout: 15_000 });
    if (!located.ok) return located;
    const candidate = located.stdout.split(/\r?\n/).map((value) => value.trim()).find(Boolean);
    if (!candidate) return { ok: false, error: new CliError("Claude Code was not found on PATH.") };
    if (candidate.toLowerCase().endsWith(".exe")) {
      const native = tryRun(candidate, args, { timeout: 15_000 });
      if (native.ok) return { ...native, versionText: `${native.stdout}\n${native.stderr}`.trim() };
    }
    return { ...located, versionText: `command found at ${candidate}` };
  }
  const result = tryRun(command, args, { timeout: 15_000 });
  if (!result.ok) return result;
  return { ...result, versionText: `${result.stdout}\n${result.stderr}`.trim() };
}

function readTerraformVersion() {
  const jsonResult = tryRun("terraform", ["version", "-json"], { cwd: TF_DIR, timeout: 15_000 });
  if (jsonResult.ok) {
    try {
      const parsed = JSON.parse(jsonResult.stdout);
      return { ok: true, versionText: String(parsed.terraform_version ?? "") };
    } catch {
      // Fall back to the plain version output below.
    }
  }
  return commandVersion("terraform", ["version"]);
}

function awsIdentity(profile, region) {
  const result = run(
    "aws",
    [
      "sts",
      "get-caller-identity",
      "--profile",
      profile,
      "--region",
      region,
      "--output",
      "json",
    ],
    { timeout: 25_000 },
  );
  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    throw new CliError("AWS CLI returned an unreadable identity response.");
  }
  if (!/^\d{12}$/.test(String(parsed.Account ?? "")) || !String(parsed.Arn ?? "")) {
    throw new CliError("AWS CLI did not return a complete account identity.");
  }
  return { account: String(parsed.Account), arn: String(parsed.Arn), userId: String(parsed.UserId ?? "") };
}

function awsS3Exists({ bucket, key = "", profile, region, accountId }) {
  const args = key
    ? ["s3api", "head-object", "--bucket", bucket, "--key", key]
    : ["s3api", "head-bucket", "--bucket", bucket];
  if (accountId) args.push("--expected-bucket-owner", accountId);
  args.push("--profile", profile, "--region", region);
  const result = tryRun("aws", args, { timeout: 25_000 });
  if (result.ok) return true;
  const message = result.error?.message ?? "";
  const classification = classifyAwsLookupError(message);
  if (classification === "missing") return false;
  if (classification === "inaccessible") {
    throw new CliError(`The S3 bucket or object is inaccessible: ${bucket}${key ? `/${key}` : ""}. Confirm ownership and permissions; a 403 is never treated as missing.`);
  }
  throw new CliError(`AWS could not verify ${bucket}${key ? `/${key}` : ""}: ${message || "unknown error"}`);
}

function awsS3HistoryExists({ bucket, key, profile, region, accountId }) {
  const result = run(
    "aws",
    [
      "s3api",
      "list-object-versions",
      "--bucket",
      bucket,
      "--prefix",
      key,
      "--max-keys",
      "1000",
      "--expected-bucket-owner",
      accountId,
      "--profile",
      profile,
      "--region",
      region,
      "--output",
      "json",
    ],
    { timeout: 60_000 },
  );
  return stateHistoryHasKey(result.stdout, key);
}

function writeBackendFiles(config, accountId) {
  const main = expectedBackend(config, accountId, MAIN_STATE_KEY);
  const bootstrap = expectedBackend(config, accountId, BOOTSTRAP_STATE_KEY);
  writeGeneratedFile(MAIN_BACKEND_CONFIG, renderBackendConfig(main));
  writeGeneratedFile(MAIN_ACCOUNT_CONFIG, renderExpectedAccountConfig(accountId));
  writeGeneratedFile(BOOTSTRAP_BACKEND_CONFIG, renderBackendConfig(bootstrap));
  writeGeneratedFile(
    BOOTSTRAP_BACKEND_FILE,
    [
      "terraform {",
      "  # Generated by npm run bootstrap-state after the bucket exists.",
      "  backend \"s3\" {}",
      "}",
      "",
    ].join("\n"),
  );
  return { main, bootstrap };
}

function terraformStatePull(directory) {
  return run("terraform", ["state", "pull"], {
    cwd: directory,
    timeout: 60_000,
    maxBuffer: 64 * 1024 * 1024,
    sensitiveOutput: true,
  }).stdout;
}

function remoteStateText({ bucket, key, profile, region, accountId, label }) {
  const temporaryDirectory = mkdtempSync(path.join(os.tmpdir(), "vault-brain-state-read-"));
  const temporaryState = path.join(temporaryDirectory, "terraform.tfstate");
  try {
    run(
      "aws",
      [
        "s3api",
        "get-object",
        "--bucket",
        bucket,
        "--key",
        key,
        "--expected-bucket-owner",
        accountId,
        "--profile",
        profile,
        "--region",
        region,
        temporaryState,
      ],
      { timeout: 60_000, sensitiveOutput: true },
    );
    const stateText = readFileSync(temporaryState, "utf8");
    stateIdentity(stateText, `Remote ${label}`);
    return stateText;
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

async function recoverInterruptedMigration({ localStatePath, bucket, key, config, identity, label }) {
  const activeText = readFileSync(localStatePath, "utf8");
  const backupPath = `${localStatePath}.backup`;
  const backupText = existsSync(backupPath) ? readFileSync(backupPath, "utf8") : null;
  const localText = recoveryLocalStateText(activeText, backupText);
  const local = stateIdentity(localText, `Local ${label}`);
  const remoteText = remoteStateText({
    bucket,
    key,
    profile: config.profile,
    region: config.region,
    accountId: identity.account,
    label,
  });
  const remote = stateIdentity(remoteText, `Remote ${label}`);
  const samePayload = sameStatePayload(localText, remoteText);
  const newerSameLineage = local.lineage === remote.lineage && remote.serial > local.serial;
  if (!samePayload && !newerSameLineage) {
    throw new CliError(`Local and remote ${label} states conflict. The runner will not overwrite either state.`);
  }
  const detail = samePayload ? "the same state content" : "a newer snapshot of the same lineage";
  const answer = await askVisible(`\nThe remote ${label} state contains ${detail}. Type RECONNECT to keep it as the source of truth: `);
  if (answer !== "RECONNECT") throw new CliError(`${label} state reconnection was not confirmed. Both state copies were kept.`);
  preserveMigratedLocalState(localStatePath, label);
}

function preserveMigratedLocalState(localStatePath, label) {
  if (!existsSync(localStatePath)) {
    throw new CliError(`The active local ${label} state disappeared before it could be preserved. Stop and verify both backends.`);
  }
  const timestamp = `${new Date().toISOString().replace(/[^0-9TZ]/g, "")}-${randomUUID().slice(0, 8)}`;
  const candidates = [
    { source: localStatePath, suffix: "migration-backup" },
    { source: `${localStatePath}.backup`, suffix: "pre-migration-backup" },
  ];
  const preserved = [];
  for (const candidate of candidates) {
    if (!existsSync(candidate.source)) continue;
    const destination = `${localStatePath}.${candidate.suffix}-${timestamp}`;
    if (existsSync(destination)) throw new CliError(`Migration recovery destination already exists: ${destination}`);
    renameSync(candidate.source, destination);
    preserved.push(destination);
  }
  if (preserved.length > 0) {
    line("KEEP", `Preserved ${label} migration recovery ${preserved.length === 1 ? "copy" : "copies"}:`, colors.yellow);
    for (const filePath of preserved) console.log(`  ${filePath}`);
    console.log("  These files are ignored by Git. Move them to encrypted storage or delete them after independently verifying the remote state.");
  }
}

function cachedBackendKind(directory, expected, localStatePath, label) {
  const metadataPath = path.join(directory, ".terraform", "terraform.tfstate");
  if (!existsSync(metadataPath)) return "none";
  const cached = readBackendMetadata(directory);
  if (!cached) {
    throw new CliError(`${label} backend metadata is unreadable at ${metadataPath}. Stop and inspect it before changing backends.`);
  }
  if (backendMatches(directory, expected)) return "expected";
  if (cached.type === "local") {
    const configuredPath = cached.config?.path;
    const resolvedPath = path.resolve(directory, configuredPath || "terraform.tfstate");
    const configuredWorkspaceDirectory = cached.config?.workspace_dir;
    const resolvedWorkspaceDirectory = configuredWorkspaceDirectory
      ? path.resolve(directory, configuredWorkspaceDirectory)
      : path.resolve(directory, "terraform.tfstate.d");
    if (
      resolvedPath !== path.resolve(localStatePath)
      || (configuredWorkspaceDirectory && resolvedWorkspaceDirectory !== path.resolve(directory, "terraform.tfstate.d"))
    ) {
      throw new CliError(`${label} uses a custom local backend path or workspace directory. The runner will not guess which local state to migrate.`);
    }
    return "local";
  }
  throw new CliError(`${label} is already initialized against a different ${cached.type || "unknown"} backend. The runner will not detach from it with -reconfigure.`);
}

function connectRemoteBackend({ directory, backendConfig, expected, localStatePath, label }) {
  const cachedKind = cachedBackendKind(directory, expected, localStatePath, label);
  if (cachedKind === "expected") {
    run("terraform", ["init", "-input=false", `-backend-config=${backendConfig}`], { cwd: directory, stdio: "inherit" });
    return;
  }
  if (existsSync(localStatePath)) {
    throw new CliError(`${label} still has local state. Migrate or reconcile it before reconnecting to S3.`);
  }
  run(
    "terraform",
    ["init", "-input=false", "-reconfigure", `-backend-config=${backendConfig}`],
    { cwd: directory, stdio: "inherit" },
  );
}

function migrateState({ directory, backendConfig, localStatePath, expected, label }) {
  const beforeText = readFileSync(localStatePath, "utf8");
  stateIdentity(beforeText, `Local ${label}`);
  const cachedKind = cachedBackendKind(directory, expected, localStatePath, label);
  if (cachedKind === "expected") {
    throw new CliError(`${label} already points at the destination backend, but its current S3 object is absent while local state remains. Restore a prior S3 version or follow a manual recovery runbook; the runner will not push local state automatically.`);
  }
  if (awsS3Exists({
    bucket: expected.bucket,
    key: expected.key,
    profile: expected.profile,
    region: expected.region,
    accountId: expected.accountId,
  })) {
    throw new CliError(`Remote ${label} state appeared before migration. Nothing was overwritten. Rerun npm run bootstrap-state to enter conflict recovery.`);
  }
  if (awsS3HistoryExists({
    bucket: expected.bucket,
    key: expected.key,
    profile: expected.profile,
    region: expected.region,
    accountId: expected.accountId,
  })) {
    throw new CliError(`Remote ${label} state has a prior version or delete marker. Restore the intended S3 version before migration; the runner will not overwrite its history.`);
  }
  run(
    "terraform",
    ["init", "-migrate-state", "-lock-timeout=30s", `-backend-config=${backendConfig}`],
    { cwd: directory, stdio: "inherit" },
  );
  if (!backendMatches(directory, expected)) {
    throw new CliError(`${label} backend metadata does not match the verified bucket, key, profile, and region.`);
  }
  const afterText = terraformStatePull(directory);
  if (!sameStatePayload(beforeText, afterText)) {
    throw new CliError(`${label} state migration could not be verified. Keep the local backup and stop.`);
  }
  preserveMigratedLocalState(localStatePath, label);
  line("PASS", `${label} state migrated and verified in S3.`, colors.green);
}

function parseOptions(argv) {
  const options = { fix: false, profile: "", client: "" };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--fix") {
      options.fix = true;
    } else if (arg === "--profile") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new CliError("--profile requires a value.", 2);
      options.profile = value;
      index += 1;
    } else if (arg === "--client") {
      const value = argv[index + 1];
      if (!value || !["claude", "chatgpt"].includes(value)) {
        throw new CliError("--client must be claude or chatgpt.", 2);
      }
      options.client = value;
      index += 1;
    } else {
      throw new CliError(`Unknown option: ${arg}`, 2);
    }
  }
  return options;
}

function installLocalPrerequisites() {
  banner("Prepare locked project dependencies");
  run("npm", ["ci"], { cwd: MCP_DIR, stdio: "inherit" });
  banner("Initialize Terraform providers");
  const initArgs = existsSync(MAIN_BACKEND_CONFIG)
    ? ["init", "-input=false", `-backend-config=${MAIN_BACKEND_CONFIG}`]
    : ["init", "-backend=false", "-input=false"];
  run("terraform", initArgs, { cwd: TF_DIR, stdio: "inherit" });
}

async function preflight(options = {}, mode = {}) {
  const { strictConfig = false, skipClient = false, requireBackend = false } = mode;
  if (options.fix) installLocalPrerequisites();

  console.log(`\n${colors.cyan("VAULT BRAIN PREFLIGHT")}`);
  let failures = 0;
  let manualChecks = 0;
  const fail = (message) => { failures += 1; line("FAIL", message, colors.red); };
  const pass = (message) => line("PASS", message, colors.green);
  const check = (message) => { manualChecks += 1; line("CHECK", message, colors.yellow); };

  pass(`Operating system: ${platformLabel()}`);
  if (versionAtLeast(process.versions.node, "22.0.0")) pass(`Node.js ${process.versions.node}`);
  else fail(`Node.js ${process.versions.node} is too old. Install Node.js 22 or newer.`);

  const git = commandVersion("git");
  git.ok ? pass(git.versionText.split(/\r?\n/)[0]) : fail("Git is missing. Install Git and rerun preflight.");

  const npm = commandVersion("npm");
  npm.ok ? pass(`npm ${npm.versionText.split(/\r?\n/)[0]}`) : fail("npm is missing. Install Node.js 22 with npm.");

  const aws = commandVersion("aws");
  aws.ok ? pass(aws.versionText.split(/\r?\n/)[0]) : fail("AWS CLI is missing. Install AWS CLI v2 and configure a named profile.");

  const terraform = readTerraformVersion();
  if (!terraform.ok) {
    fail("Terraform is missing. Install Terraform 1.10 or newer.");
  } else if (!versionAtLeast(terraform.versionText, "1.10.0")) {
    fail(`Terraform ${terraform.versionText} is too old. Install Terraform 1.10 or newer.`);
  } else {
    pass(`Terraform ${terraform.versionText}`);
  }

  const requiredFiles = [
    ".git",
    "mcp-server/package.json",
    "mcp-server/package-lock.json",
    "mcp-server/build.mjs",
    "terraform/versions.tf",
    "terraform/backend.tf",
    "terraform/variables.tf",
    "state-bootstrap/versions.tf",
    "state-bootstrap/state_bucket.tf",
    "vault-starter/+Inbox/welcome.md",
    "vault-starter/System/schema.md",
  ];
  const missingFiles = requiredFiles.filter((relative) => !existsSync(path.join(ROOT, relative)));
  missingFiles.length === 0
    ? pass("Repository files are complete")
    : fail(`Repository is incomplete. Missing: ${missingFiles.join(", ")}`);

  const dependenciesReady = [
    "node_modules/.package-lock.json",
    "node_modules/typescript/package.json",
    "node_modules/esbuild/package.json",
    "node_modules/@aws-sdk/credential-provider-ini/package.json",
  ].every((relative) => existsSync(path.join(MCP_DIR, relative)));
  dependenciesReady
    ? pass("Locked MCP server dependencies are installed")
    : fail("MCP server dependencies are missing. Run: npm run preflight -- --fix");

  const terraformInitialized = existsSync(path.join(TF_DIR, ".terraform"));
  const cachedBackend = readBackendMetadata(TF_DIR);
  if (!terraformInitialized) {
    fail("Terraform providers are not initialized. Run: npm run preflight -- --fix");
  } else if (cachedBackend?.type === "s3" && existsSync(MAIN_BACKEND_CONFIG)) {
    const validate = tryRun("terraform", ["validate", "-json"], { cwd: TF_DIR, timeout: 30_000 });
    if (!validate.ok) {
      fail("Terraform validation could not run. Try: npm run preflight -- --fix");
    } else {
      try {
        const result = JSON.parse(validate.stdout);
        result.valid ? pass("Terraform configuration is valid") : fail("Terraform validation reported errors. Run terraform validate for details.");
      } catch {
        fail("Terraform returned an unreadable validation result.");
      }
    }
  } else {
    check("Terraform providers are installed. The S3 backend will be initialized by npm run bootstrap-state.");
  }

  let config = null;
  try {
    config = loadConfig(strictConfig);
    if (!config) {
      check("Stack configuration is not created yet. Run npm run configure before deployment.");
    } else {
      const configErrors = validateConfig(config);
      if (configErrors.length > 0) {
        for (const error of configErrors) fail(error);
      } else {
        pass(`Stack configuration: ${config.project_name} in ${config.region}`);
      }
      const ignored = tryRun("git", ["check-ignore", "-q", "terraform/terraform.tfvars"]);
      ignored.ok ? pass("terraform.tfvars is excluded from Git") : fail("terraform.tfvars is not ignored by Git. Do not deploy until it is excluded.");
    }
  } catch (error) {
    fail(error.message);
  }

  let identity = null;
  const profile = options.profile || config?.profile || "";
  const region = config?.region || process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "us-east-1";
  if (!profile) {
    fail("No AWS profile was selected. Use --profile <PROFILE>, or set profile in terraform.tfvars.");
  } else if (aws.ok) {
    try {
      identity = awsIdentity(profile, region);
      pass(`AWS profile ${profile} is authenticated`);
      check(`Confirm this is your AWS account: ${identity.account} (${identity.arn})`);
    } catch (error) {
      fail(`AWS identity check failed for profile ${profile}: ${error.message}`);
    }
  }

  let remoteBackendReady = false;
  if (config && identity) {
    const expected = expectedBackend(config, identity.account, MAIN_STATE_KEY);
    remoteBackendReady = existsSync(MAIN_BACKEND_CONFIG)
      && backendMatches(TF_DIR, expected)
      && expectedAccountMatches(identity.account);
    if (remoteBackendReady) {
      const backendIgnored = tryRun("git", ["check-ignore", "-q", "terraform/backend.s3.tfbackend"]);
      const accountIgnored = tryRun("git", ["check-ignore", "-q", "terraform/backend.auto.tfvars.json"]);
      backendIgnored.ok && accountIgnored.ok
        ? pass(`Remote Terraform state: s3://${expected.bucket}/${expected.key}`)
        : fail("Generated backend and account-guard files are not both ignored by Git.");
      if (existsSync(path.join(TF_DIR, "terraform.tfstate"))) {
        fail("A local main Terraform state still exists after backend setup. Stop and verify migration before deployment.");
      }
    } else if (requireBackend) {
      fail("Remote Terraform state is not ready. Run npm run bootstrap-state before deployment.");
    } else {
      check("Remote Terraform state is not ready yet. Run npm run bootstrap-state after configuration.");
    }
  }

  if (!skipClient) {
    if (options.client === "chatgpt") {
      check("Open ChatGPT Plugins and verify Add > Create MCP App is available to this account.");
    } else {
      const claude = commandVersion("claude");
      if (claude.ok) {
        pass(`Claude Code detected: ${claude.versionText.split(/\r?\n/)[0]}`);
      } else if (options.client === "claude") {
        fail("Claude Code was selected but its claude command is missing.");
      } else {
        check("Claude Code was not detected. Verify ChatGPT Plugins > Add > Create MCP App if ChatGPT is your client.");
      }
    }
  }

  console.log();
  if (failures > 0) {
    line("BLOCKED", `${failures} required check${failures === 1 ? "" : "s"} failed. Fix them and rerun npm run preflight.`, colors.red);
  } else if (!config) {
    line("READY", "Environment ready. Run npm run configure when the workshop reaches stack configuration.", colors.green);
  } else if (!remoteBackendReady) {
    line("READY", "Configuration ready. Next: npm run bootstrap-state.", colors.green);
  } else {
    line("READY", `Ready to deploy after you confirm AWS account ${identity?.account ?? "above"}.`, colors.green);
  }
  if (manualChecks > 0) line("CHECK", `${manualChecks} item${manualChecks === 1 ? "" : "s"} require human confirmation.`, colors.yellow);

  return { ok: failures === 0, config, identity, profile, region, remoteBackendReady };
}

function configure() {
  if (!existsSync(TFVARS_EXAMPLE)) throw new CliError("terraform/terraform.tfvars.example is missing.");
  if (existsSync(TFVARS)) {
    line("KEEP", "terraform/terraform.tfvars already exists and was not changed.", colors.yellow);
  } else {
    copyFileSync(TFVARS_EXAMPLE, TFVARS);
    line("CREATED", "terraform/terraform.tfvars from the tracked example.", colors.green);
  }
  console.log(`\nEdit this file before deployment:\n  ${TFVARS}\n\nThen run:\n  npm run preflight`);
}

async function askVisible(prompt) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new CliError("This operation requires an interactive terminal.");
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(prompt)).trim();
  } finally {
    rl.close();
  }
}

async function askSecret(prompt) {
  if (!process.stdin.isTTY || !process.stdout.isTTY || typeof process.stdin.setRawMode !== "function") {
    throw new CliError("Password entry requires an interactive terminal.");
  }
  return new Promise((resolve, reject) => {
    let value = "";
    let unsupportedInput = false;
    let escapeState = 0;
    const wasRaw = Boolean(process.stdin.isRaw);
    const cleanup = () => {
      process.stdin.off("data", onData);
      process.stdin.setRawMode(wasRaw);
      if (process.stdin.listenerCount("data") === 0) process.stdin.pause();
      process.stdout.write("\n");
    };
    const finish = () => {
      cleanup();
      resolve(value);
    };
    const cancel = () => {
      cleanup();
      reject(new CancelledError());
    };
    const onData = (buffer) => {
      for (const byte of buffer) {
        if (byte === 3) return cancel();
        if (byte === 13 || byte === 10) {
          if (unsupportedInput) {
            value = "";
            unsupportedInput = false;
            escapeState = 0;
            process.stdout.write("\n");
            line("RETRY", "Use printable ASCII characters only.", colors.yellow);
            process.stdout.write(prompt);
            continue;
          }
          return finish();
        }
        if (escapeState === 1) {
          escapeState = byte === 91 || byte === 79 ? 2 : 0;
          continue;
        }
        if (escapeState === 2) {
          if (byte >= 64 && byte <= 126) escapeState = 0;
          continue;
        }
        if (byte === 27) {
          escapeState = 1;
          continue;
        }
        if (byte === 8 || byte === 127) {
          if (value.length > 0) {
            value = value.slice(0, -1);
            process.stdout.write("\b \b");
          }
          continue;
        }
        if (byte >= 128) {
          unsupportedInput = true;
          continue;
        }
        if (byte >= 32 && byte <= 126) {
          value += String.fromCharCode(byte);
          process.stdout.write("*");
        }
      }
    };
    process.stdout.write(prompt);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on("data", onData);
  });
}

function bootstrapVarArgs(config, accountId) {
  return [
    `-var=project_name=${config.project_name}`,
    `-var=profile=${config.profile}`,
    `-var=region=${config.region}`,
    `-var=account_id=${accountId}`,
  ];
}

async function reconcileStateBucket(config, identity) {
  const planDirectory = mkdtempSync(path.join(os.tmpdir(), "vault-brain-state-plan-"));
  const planPath = path.join(planDirectory, "state-bootstrap.tfplan");
  try {
    const plan = run(
      "terraform",
      ["plan", "-input=false", "-lock-timeout=30s", "-detailed-exitcode", `-out=${planPath}`, ...bootstrapVarArgs(config, identity.account)],
      { cwd: STATE_TF_DIR, stdio: "inherit", acceptedExitCodes: [0, 2] },
    );
    const planned = plannedIdentityFromFile(planPath, STATE_TF_DIR);
    if (
      planned.accountId !== identity.account
      || planned.profile !== config.profile
      || planned.region !== config.region
    ) {
      throw new CliError("The state-bucket plan does not match the verified AWS account, profile, and region.");
    }
    if (plan.status === 0) {
      line("PASS", "The protected state bucket already matches this configuration.", colors.green);
      return;
    }
    const applyAnswer = await askVisible("\nType APPLY to create or repair this reviewed state-bucket plan: ");
    if (applyAnswer !== "APPLY") throw new CliError("State-bucket apply was not confirmed. Nothing was changed.");
    const current = awsIdentity(config.profile, config.region);
    if (current.account !== identity.account || current.arn !== identity.arn) {
      throw new CliError("AWS identity changed after confirmation. The state-bucket plan was not applied.");
    }
    run("terraform", ["apply", "-input=false", "-lock-timeout=30s", planPath], { cwd: STATE_TF_DIR, stdio: "inherit" });
  } finally {
    rmSync(planDirectory, { recursive: true, force: true });
  }
}

async function bootstrapState(options) {
  if (options.fix || options.profile || options.client) {
    throw new CliError("npm run bootstrap-state does not accept options. Save the verified profile in terraform.tfvars.", 2);
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new CliError("State bootstrap requires an interactive terminal. Automatic approval is intentionally unsupported.");
  }
  assertDefaultWorkspaceOnly(STATE_TF_DIR, "State bootstrap");
  assertDefaultWorkspaceOnly(TF_DIR, "Vault Brain");

  banner("1/4 Verify the state owner");
  const readiness = await preflight({}, { strictConfig: true, skipClient: true });
  if (!readiness.ok || !readiness.config || !readiness.identity) {
    throw new CliError("State bootstrap stopped because preflight did not pass.");
  }
  const { config, identity } = readiness;
  const bucket = stateBucketName(config.project_name, identity.account);
  console.log(`\nState bucket: ${bucket}`);
  console.log(`AWS account:  ${identity.account}`);
  console.log(`AWS identity: ${identity.arn}`);
  console.log(`Region:       ${config.region}`);
  const accountAnswer = await askVisible(`\nType the AWS account ID ${identity.account} to continue: `);
  if (accountAnswer !== identity.account) throw new CliError("AWS account confirmation did not match. Nothing was changed.");

  banner("2/4 Create or verify the protected state bucket");
  const bucketExists = awsS3Exists({ bucket, profile: config.profile, region: config.region, accountId: identity.account });
  const localBootstrapState = existsSync(path.join(STATE_TF_DIR, "terraform.tfstate"));
  const remoteBootstrapState = bucketExists && awsS3Exists({
    bucket,
    key: BOOTSTRAP_STATE_KEY,
    profile: config.profile,
    region: config.region,
    accountId: identity.account,
  });
  if (bucketExists && !remoteBootstrapState && awsS3HistoryExists({
    bucket,
    key: BOOTSTRAP_STATE_KEY,
    profile: config.profile,
    region: config.region,
    accountId: identity.account,
  })) {
    throw new CliError("The current bootstrap state object is missing, but S3 retains a prior version or delete marker. Restore the intended version before continuing.");
  }
  let bootstrapDecision = migrationDecision({
    localState: localBootstrapState,
    remoteState: remoteBootstrapState,
    bucketExists,
  });

  if (bootstrapDecision === "conflict") {
    await recoverInterruptedMigration({
      localStatePath: path.join(STATE_TF_DIR, "terraform.tfstate"),
      bucket,
      key: BOOTSTRAP_STATE_KEY,
      config,
      identity,
      label: "bootstrap",
    });
    bootstrapDecision = "remote";
  }
  if (bootstrapDecision === "orphaned") {
    throw new CliError(`Bucket ${bucket} exists, but neither local nor remote bootstrap state proves ownership. Stop and inspect it before importing or deleting anything.`);
  }
  if (bootstrapDecision === "create") {
    if (existsSync(BOOTSTRAP_BACKEND_FILE) || existsSync(BOOTSTRAP_BACKEND_CONFIG)) {
      throw new CliError("Generated bootstrap backend files exist but the bucket is missing. Stop and inspect the previous backend before continuing.");
    }
    run("terraform", ["init", "-input=false"], { cwd: STATE_TF_DIR, stdio: "inherit" });
    await reconcileStateBucket(config, identity);
    if (!awsS3Exists({ bucket, profile: config.profile, region: config.region, accountId: identity.account })) {
      throw new CliError("Terraform applied, but the state bucket could not be verified.");
    }
  } else {
    writeBackendFiles(config, identity.account);
    if (bootstrapDecision === "migrate") {
      const answer = await askVisible("\nType MIGRATE to copy the bootstrap state into its protected S3 backend: ");
      if (answer !== "MIGRATE") throw new CliError("Bootstrap state migration was not confirmed. The local state was kept.");
      migrateState({
        directory: STATE_TF_DIR,
        backendConfig: BOOTSTRAP_BACKEND_CONFIG,
        localStatePath: path.join(STATE_TF_DIR, "terraform.tfstate"),
        expected: expectedBackend(config, identity.account, BOOTSTRAP_STATE_KEY),
        label: "Bootstrap",
      });
    } else {
      connectRemoteBackend({
        directory: STATE_TF_DIR,
        backendConfig: BOOTSTRAP_BACKEND_CONFIG,
        expected: expectedBackend(config, identity.account, BOOTSTRAP_STATE_KEY),
        localStatePath: path.join(STATE_TF_DIR, "terraform.tfstate"),
        label: "State bootstrap",
      });
    }
    await reconcileStateBucket(config, identity);
  }

  banner("3/4 Protect the bootstrap state");
  const backends = writeBackendFiles(config, identity.account);
  if (!backendMatches(STATE_TF_DIR, backends.bootstrap)) {
    const localStatePath = path.join(STATE_TF_DIR, "terraform.tfstate");
    if (!existsSync(localStatePath)) {
      throw new CliError("The local bootstrap state is missing before migration. Stop and inspect the bucket before continuing.");
    }
    const answer = await askVisible("\nType MIGRATE to copy the bootstrap state into its protected S3 backend: ");
    if (answer !== "MIGRATE") throw new CliError("Bootstrap state migration was not confirmed. The local state was kept.");
    migrateState({
      directory: STATE_TF_DIR,
      backendConfig: BOOTSTRAP_BACKEND_CONFIG,
      localStatePath,
      expected: backends.bootstrap,
      label: "Bootstrap",
    });
  } else {
    line("PASS", "Bootstrap state already uses the protected S3 backend.", colors.green);
  }
  if (bootstrapDecision === "create") {
    await reconcileStateBucket(config, identity);
  }
  line("PASS", "State bucket protection and native S3 locking verified.", colors.green);

  banner("4/4 Initialize the Vault Brain backend");
  const localMainStatePath = path.join(TF_DIR, "terraform.tfstate");
  const localMainState = existsSync(localMainStatePath);
  const remoteMainState = awsS3Exists({
    bucket,
    key: MAIN_STATE_KEY,
    profile: config.profile,
    region: config.region,
    accountId: identity.account,
  });
  if (!remoteMainState && awsS3HistoryExists({
    bucket,
    key: MAIN_STATE_KEY,
    profile: config.profile,
    region: config.region,
    accountId: identity.account,
  })) {
    throw new CliError("The current Vault Brain state object is missing, but S3 retains a prior version or delete marker. Restore the intended version before planning or migration.");
  }
  if (localMainState && remoteMainState) {
    await recoverInterruptedMigration({
      localStatePath: localMainStatePath,
      bucket,
      key: MAIN_STATE_KEY,
      config,
      identity,
      label: "Vault Brain",
    });
  }
  if (localMainState && !remoteMainState) {
    const answer = await askVisible("\nType MIGRATE to copy the existing Vault Brain state into S3: ");
    if (answer !== "MIGRATE") throw new CliError("Vault Brain state migration was not confirmed. The local state was kept.");
    migrateState({
      directory: TF_DIR,
      backendConfig: MAIN_BACKEND_CONFIG,
      localStatePath: localMainStatePath,
      expected: backends.main,
      label: "Vault Brain",
    });
  } else {
    connectRemoteBackend({
      directory: TF_DIR,
      backendConfig: MAIN_BACKEND_CONFIG,
      expected: backends.main,
      localStatePath: localMainStatePath,
      label: "Vault Brain",
    });
  }
  if (!backendMatches(TF_DIR, backends.main)) {
    throw new CliError("The Vault Brain backend does not match the verified bucket, key, profile, region, encryption, and lock settings.");
  }
  const ignored = tryRun("git", ["check-ignore", "-q", "terraform/backend.s3.tfbackend"]);
  if (!ignored.ok) throw new CliError("The generated backend config is not ignored by Git.");
  const accountIgnored = tryRun("git", ["check-ignore", "-q", "terraform/backend.auto.tfvars.json"]);
  if (!accountIgnored.ok || !expectedAccountMatches(identity.account)) {
    throw new CliError("The generated provider account guard is missing, incorrect, or not ignored by Git.");
  }
  if (existsSync(localMainStatePath)) {
    throw new CliError("A local Vault Brain state remains after migration. Keep it private and verify the remote copy before deployment.");
  }
  console.log(`\n${colors.green("STATE BACKEND READY")}\n`);
  console.log(`Main state location:\n  s3://${bucket}/${MAIN_STATE_KEY}`);
  console.log("  The object appears when the first application plan or apply writes state.");
  console.log("Locking:\n  S3 native lockfile enabled");
  console.log("\nNext: npm run deploy");
}

function terraformOutput(name) {
  return run("terraform", ["output", "-raw", name], { cwd: TF_DIR, timeout: 30_000 }).stdout.trim();
}

export function plannedIdentityFromJson(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new CliError("Terraform returned an unreadable saved plan.");
  }
  const outputs = parsed?.planned_values?.outputs;
  const planned = {
    accountId: String(outputs?.aws_account_id?.value ?? ""),
    profile: String(outputs?.aws_profile?.value ?? ""),
    region: String(outputs?.region?.value ?? ""),
  };
  if (!/^\d{12}$/.test(planned.accountId) || !planned.profile || !planned.region) {
    throw new CliError("The saved Terraform plan does not expose a complete AWS identity.");
  }
  return planned;
}

function plannedIdentityFromFile(planPath, directory = TF_DIR) {
  let raw = "";
  try {
    raw = run("terraform", ["show", "-json", planPath], {
      cwd: directory,
      timeout: 60_000,
      maxBuffer: 64 * 1024 * 1024,
      sensitiveOutput: true,
    }).stdout;
    return plannedIdentityFromJson(raw);
  } finally {
    raw = "";
  }
}

async function setPermanentPassword(context = null) {
  const config = context?.config ?? loadConfig(true);
  const profile = context?.profile ?? config.profile;
  const region = context?.region ?? config.region;
  const poolId = terraformOutput("cognito_user_pool_id");
  const email = terraformOutput("cognito_login_email");

  let password;
  while (true) {
    const first = await askSecret("New Vault Brain password: ");
    const errors = [];
    if (first.length < 12) errors.push("at least 12 characters");
    if (!/[a-z]/.test(first)) errors.push("a lowercase letter");
    if (!/[A-Z]/.test(first)) errors.push("an uppercase letter");
    if (!/\d/.test(first)) errors.push("a number");
    if (errors.length > 0) {
      line("RETRY", `Use ${errors.join(", ")}.`, colors.yellow);
      continue;
    }
    const second = await askSecret("Confirm password: ");
    if (first !== second) {
      line("RETRY", "The passwords did not match.", colors.yellow);
      continue;
    }
    password = first;
    break;
  }

  const requireFromMcp = createRequire(path.join(MCP_DIR, "package.json"));
  let CognitoIdentityProviderClient;
  let AdminSetUserPasswordCommand;
  let fromIni;
  try {
    ({ CognitoIdentityProviderClient, AdminSetUserPasswordCommand } = requireFromMcp("@aws-sdk/client-cognito-identity-provider"));
    ({ fromIni } = requireFromMcp("@aws-sdk/credential-provider-ini"));
  } catch {
    password = undefined;
    throw new CliError("AWS SDK dependencies are missing. Run npm run preflight -- --fix.");
  }

  const client = new CognitoIdentityProviderClient({
    region,
    credentials: fromIni({ profile }),
  });
  try {
    await client.send(new AdminSetUserPasswordCommand({
      UserPoolId: poolId,
      Username: email,
      Password: password,
      Permanent: true,
    }));
  } finally {
    password = undefined;
    client.destroy();
  }
  line("PASS", `Permanent Cognito password set for ${email}.`, colors.green);
}

export function s3ListingHasMarkdown(listing) {
  return String(listing).split(/\r?\n/).some((entry) => /\.md\s*$/i.test(entry));
}

function seedVault(outputs) {
  const list = run(
    "aws",
    [
      "s3",
      "ls",
      `s3://${outputs.bucket}/`,
      "--recursive",
      "--profile",
      outputs.profile,
      "--region",
      outputs.region,
    ],
    { timeout: 60_000 },
  );
  if (s3ListingHasMarkdown(list.stdout)) {
    line("KEEP", "The vault already contains Markdown, including possible trash history. Starter notes were not uploaded.", colors.yellow);
    return;
  }
  run(
    "aws",
    [
      "s3",
      "sync",
      `${path.join(ROOT, "vault-starter")}${path.sep}`,
      `s3://${outputs.bucket}/`,
      "--profile",
      outputs.profile,
      "--region",
      outputs.region,
    ],
    { stdio: "inherit" },
  );
  line("PASS", "Seeded the starter vault.", colors.green);
}

async function deploy(options) {
  if (options.fix || options.profile || options.client) {
    throw new CliError("npm run deploy does not accept preflight options. Save the profile in terraform.tfvars.", 2);
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new CliError("Deployment requires an interactive terminal. Automatic approval is intentionally unsupported.");
  }
  assertDefaultWorkspaceOnly(TF_DIR, "Vault Brain");

  banner("1/5 Prepare and validate the local build");
  installLocalPrerequisites();
  run("npm", ["run", "build"], { cwd: MCP_DIR, stdio: "inherit" });
  const readiness = await preflight({}, { strictConfig: true, skipClient: true, requireBackend: true });
  if (!readiness.ok || !readiness.config || !readiness.identity) {
    throw new CliError("Deployment stopped because preflight did not pass.");
  }

  const { config, identity } = readiness;
  const workspace = run("terraform", ["workspace", "show"], { cwd: TF_DIR, timeout: 30_000 }).stdout.trim();
  if (workspace !== "default") {
    throw new CliError(`Terraform workspace ${workspace || "<unknown>"} is active. Switch to the default workspace before this workshop deployment.`);
  }
  const mainBackend = expectedBackend(config, identity.account, MAIN_STATE_KEY);
  const currentMainState = awsS3Exists({
    bucket: mainBackend.bucket,
    key: mainBackend.key,
    profile: mainBackend.profile,
    region: mainBackend.region,
    accountId: mainBackend.accountId,
  });
  if (!currentMainState && awsS3HistoryExists({
    bucket: mainBackend.bucket,
    key: mainBackend.key,
    profile: mainBackend.profile,
    region: mainBackend.region,
    accountId: mainBackend.accountId,
  })) {
    throw new CliError("The current Vault Brain state object is missing, but S3 retains a prior version or delete marker. Restore the intended version before deployment.");
  }
  if (currentMainState) {
    const recordedAccount = tryRun("terraform", ["output", "-raw", "aws_account_id"], {
      cwd: TF_DIR,
      timeout: 30_000,
      sensitiveOutput: true,
    });
    if (!recordedAccount.ok || !/^\d{12}$/.test(recordedAccount.stdout.trim())) {
      throw new CliError("Remote Vault Brain state exists, but its AWS account output is missing or unreadable. Stop and inspect the state before planning.");
    }
    if (recordedAccount.stdout.trim() !== identity.account) {
      throw new CliError(
        `Existing remote Terraform state belongs to AWS account ${recordedAccount.stdout.trim()}, but profile ${config.profile} resolves to ${identity.account}.`,
      );
    }
    line("PASS", "Existing remote Terraform state matches the active AWS account.", colors.green);
  } else {
    line("CHECK", "The remote backend has no deployed Vault Brain state yet. This apply will create its first state version.", colors.yellow);
  }
  console.log(`\nProject:     ${config.project_name}`);
  console.log(`AWS account: ${identity.account}`);
  console.log(`AWS identity:${identity.arn ? ` ${identity.arn}` : ""}`);
  console.log(`Region:      ${config.region}`);
  const accountAnswer = await askVisible(`\nType the AWS account ID ${identity.account} to continue: `);
  if (accountAnswer !== identity.account) throw new CliError("AWS account confirmation did not match. Nothing was deployed.");

  banner("2/5 Create and review the Terraform plan");
  const planDirectory = mkdtempSync(path.join(os.tmpdir(), "vault-brain-plan-"));
  const planPath = path.join(planDirectory, "workshop.tfplan");
  try {
    run(
      "terraform",
      ["plan", "-input=false", "-lock-timeout=30s", "-detailed-exitcode", `-out=${planPath}`],
      { cwd: TF_DIR, stdio: "inherit", acceptedExitCodes: [0, 2] },
    );
    const planned = plannedIdentityFromFile(planPath);
    if (
      planned.accountId !== identity.account
      || planned.profile !== config.profile
      || planned.region !== config.region
    ) {
      throw new CliError(
        `Saved plan identity mismatch. Expected account ${identity.account}, profile ${config.profile}, region ${config.region}; planned account ${planned.accountId}, profile ${planned.profile}, region ${planned.region}.`,
      );
    }
    line("PASS", "The saved plan matches the confirmed AWS account, profile, and region.", colors.green);
    const applyAnswer = await askVisible("\nType APPLY to deploy this reviewed plan: ");
    if (applyAnswer !== "APPLY") throw new CliError("Terraform apply was not confirmed. Nothing was deployed.");

    const secondIdentity = awsIdentity(config.profile, config.region);
    if (secondIdentity.account !== identity.account || secondIdentity.arn !== identity.arn) {
      throw new CliError("AWS identity changed after confirmation. The plan was not applied.");
    }

    banner("3/5 Apply the reviewed Terraform plan");
    run("terraform", ["apply", "-input=false", "-lock-timeout=30s", planPath], { cwd: TF_DIR, stdio: "inherit" });
  } finally {
    rmSync(planDirectory, { recursive: true, force: true });
  }

  const outputs = {
    accountId: terraformOutput("aws_account_id"),
    connectorUrl: terraformOutput("mcp_connector_url"),
    hostedUi: terraformOutput("cognito_hosted_ui_url"),
    bucket: terraformOutput("vault_bucket"),
    region: terraformOutput("region"),
    profile: terraformOutput("aws_profile"),
    poolId: terraformOutput("cognito_user_pool_id"),
    email: terraformOutput("cognito_login_email"),
  };
  if (outputs.accountId !== identity.account) {
    throw new CliError(`Terraform recorded AWS account ${outputs.accountId}, expected ${identity.account}. Seeding and password setup were stopped.`);
  }

  banner("4/5 Seed only when no Markdown exists");
  seedVault(outputs);

  banner("5/5 Set the permanent owner password");
  try {
    await setPermanentPassword(readiness);
  } catch (error) {
    console.error(`\n${colors.red("The AWS stack exists, but the permanent owner password was not set.")}`);
    console.error("Run npm run set-password after resolving the error.");
    throw error;
  }

  console.log(`\n${colors.green("DEPLOYMENT COMPLETE")}\n`);
  console.log(`MCP endpoint:\n  ${outputs.connectorUrl}`);
  console.log(`\nCognito sign-in base URL:\n  ${outputs.hostedUi}`);
  console.log(`\nOwner username:\n  ${outputs.email}`);
  console.log(`\nObsidian S3 settings:\n  endpoint: https://s3.${outputs.region}.amazonaws.com\n  region:   ${outputs.region}\n  bucket:   ${outputs.bucket}`);
  console.log("\nRead the two Obsidian access keys only on a private screen:");
  console.log("  terraform -chdir=terraform output -raw sync_access_key_id");
  console.log("  terraform -chdir=terraform output -raw sync_secret_access_key");
  console.log("\nNext: npm run smoke");
}

function resultText(payload, action) {
  if (!payload || typeof payload !== "object" || payload.error) {
    const code = payload?.error?.code;
    const message = payload?.error?.message;
    throw new CliError(`${action} returned a JSON-RPC error${code ? ` ${code}` : ""}${message ? `: ${message}` : "."}`);
  }
  if (payload.result?.isError) throw new CliError(`${action} returned a tool error.`);
  const content = payload.result?.content;
  if (!Array.isArray(content)) throw new CliError(`${action} returned no MCP content.`);
  return content.filter((item) => item?.type === "text" && typeof item.text === "string").map((item) => item.text).join("\n");
}

async function fetchWithTimeout(url, init, action, retries = 0) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const response = await fetch(url, { ...init, signal: AbortSignal.timeout(20_000) });
      if (attempt < retries && (response.status === 429 || response.status >= 500)) {
        await response.body?.cancel();
        await new Promise((resolve) => setTimeout(resolve, 250 * (2 ** attempt)));
        continue;
      }
      return response;
    } catch (error) {
      lastError = error;
      if (attempt >= retries) break;
      await new Promise((resolve) => setTimeout(resolve, 250 * (2 ** attempt)));
    }
  }
  throw new CliError(`${action} could not reach the endpoint${lastError ? `: ${lastError.message}` : "."}`);
}

async function rpc(url, token, id, method, params = {}, retries = 0) {
  const response = await fetchWithTimeout(
    url,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    },
    method,
    retries,
  );
  if (!response.ok) throw new CliError(`${method} returned HTTP ${response.status}.`);
  try {
    return await response.json();
  } catch {
    throw new CliError(`${method} returned invalid JSON.`);
  }
}

export function validateToolNames(names) {
  const actual = [...new Set(names)].sort();
  return names.length === EXPECTED_TOOLS.length
    && actual.length === EXPECTED_TOOLS.length
    && actual.every((name, index) => name === EXPECTED_TOOLS[index]);
}

export function validSmokeKey(value) {
  return typeof value === "string"
    && value.startsWith("+Inbox/")
    && value.toLowerCase().endsWith(".md")
    && !value.includes("\\")
    && !value.split("/").includes("..");
}

export function validTrashKey(value) {
  return typeof value === "string"
    && value.startsWith(".trash/")
    && value.toLowerCase().endsWith(".md")
    && !value.includes("\\")
    && !value.split("/").includes("..");
}

async function smoke() {
  assertDefaultWorkspaceOnly(TF_DIR, "Vault Brain");
  const url = terraformOutput("mcp_connector_url");
  let token = terraformOutput("mcp_bearer_token");
  const base = url.endsWith("/mcp") ? url.slice(0, -4) : url.replace(/\/$/, "");
  const marker = `vault-brain-smoke-${randomUUID()}`;
  let createdKey = "";
  let trashKey = "";
  let captureAttempted = false;
  let temporaryNoteRemoved = false;
  let requestId = 1;

  console.log(`Endpoint: ${url}\n`);
  try {
    const initialized = await rpc(url, token, requestId++, "initialize", {}, 2);
    if (initialized?.result?.serverInfo?.name !== "vault-brain-server") {
      throw new CliError("initialize returned an unexpected server identity.");
    }
    line("PASS", "initialize returns serverInfo vault-brain-server", colors.green);

    const listed = await rpc(url, token, requestId++, "tools/list");
    const tools = listed?.result?.tools;
    if (!Array.isArray(tools)) throw new CliError("tools/list returned no tools array.");
    const names = tools.map((tool) => tool?.name).filter((name) => typeof name === "string");
    if (!validateToolNames(names)) throw new CliError("tools/list did not return the exact expected 12-tool set.");
    line("PASS", "tools/list returns the exact 12-tool contract", colors.green);

    captureAttempted = true;
    const captured = await rpc(url, token, requestId++, "tools/call", {
      name: "capture",
      arguments: { text: marker, title: marker },
    });
    const captureText = resultText(captured, "capture");
    const keyMatch = captureText.match(/^Captured to (\+Inbox\/[^\r\n]+\.md)$/m);
    createdKey = keyMatch?.[1] ?? "";
    if (!validSmokeKey(createdKey)) throw new CliError("capture did not return a safe +Inbox Markdown path.");
    line("PASS", `capture wrote ${createdKey}`, colors.green);

    const read = await rpc(url, token, requestId++, "tools/call", {
      name: "read_note",
      arguments: { path: createdKey },
    });
    if (!resultText(read, "read_note").includes(marker)) throw new CliError("read_note did not return the smoke marker.");
    line("PASS", "read_note returns the captured marker", colors.green);

    const schema = await rpc(url, token, requestId++, "tools/call", {
      name: "describe_schema",
      arguments: {},
    });
    if (!resultText(schema, "describe_schema").includes("Vault schema")) {
      throw new CliError("describe_schema did not return System/schema.md.");
    }
    line("PASS", "describe_schema returns System/schema.md", colors.green);

    const trashed = await rpc(url, token, requestId++, "tools/call", {
      name: "trash_note",
      arguments: { path: createdKey },
    });
    const trashText = resultText(trashed, "trash_note");
    const trashMatch = trashText.match(/ to (\.trash\/[^\r\n]+\.md)\./);
    trashKey = trashMatch?.[1] ?? "";
    if (!validTrashKey(trashKey)) {
      throw new CliError("trash_note did not return a safe trash path.");
    }
    createdKey = "";
    line("PASS", "trash_note moved the temporary note into .trash/", colors.green);

    const removed = await rpc(url, token, requestId++, "tools/call", {
      name: "delete_note",
      arguments: { path: trashKey },
    });
    if (!resultText(removed, "delete_note").startsWith(`Deleted ${trashKey} `)) {
      throw new CliError("delete_note did not remove the temporary trash note.");
    }
    trashKey = "";
    temporaryNoteRemoved = true;
    line("PASS", "temporary smoke note was removed", colors.green);

    const unauthenticated = await fetchWithTimeout(
      url,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: requestId++, method: "tools/list", params: {} }),
      },
      "unauthenticated check",
    );
    if (unauthenticated.status !== 401) throw new CliError(`Unauthenticated request returned ${unauthenticated.status}, expected 401.`);
    line("PASS", "an unauthenticated call is rejected with 401", colors.green);

    const discovery = await fetchWithTimeout(`${base}/.well-known/oauth-protected-resource`, {}, "OAuth discovery");
    if (!discovery.ok) throw new CliError(`OAuth discovery returned HTTP ${discovery.status}.`);
    let metadata;
    try {
      metadata = await discovery.json();
    } catch {
      throw new CliError("OAuth discovery returned invalid JSON.");
    }
    if (metadata?.resource !== url) throw new CliError("OAuth discovery advertises a different protected resource URL.");
    line("PASS", "OAuth discovery is public and advertises this MCP endpoint", colors.green);

    console.log(`\n${colors.green("ALL SMOKE CHECKS PASSED")}`);
  } finally {
    try {
      if (createdKey && validSmokeKey(createdKey)) {
        const cleanupTrash = await rpc(url, token, requestId++, "tools/call", {
          name: "trash_note",
          arguments: { path: createdKey },
        });
        const match = resultText(cleanupTrash, "cleanup trash").match(/ to (\.trash\/[^\r\n]+\.md)\./);
        const cleanupTrashKey = match?.[1] ?? "";
        if (!validTrashKey(cleanupTrashKey)) throw new CliError("cleanup trash did not return a safe trash path.");
        trashKey = cleanupTrashKey;
        createdKey = "";
      }
      if (validTrashKey(trashKey)) {
        const cleanupDelete = await rpc(url, token, requestId++, "tools/call", {
          name: "delete_note",
          arguments: { path: trashKey },
        });
        if (!resultText(cleanupDelete, "cleanup delete").startsWith(`Deleted ${trashKey} `)) {
          throw new CliError("cleanup delete did not confirm removal.");
        }
        temporaryNoteRemoved = true;
        trashKey = "";
      }
    } catch {
      // The single warning below includes the unique marker needed for recovery.
    }
    if (captureAttempted && !temporaryNoteRemoved) {
      line("WARN", `The smoke test could not prove cleanup. Search +Inbox and .trash for ${marker} before rerunning.`, colors.yellow);
    }
    token = undefined;
  }
}

function help() {
  console.log(`Vault Brain workshop runner

Usage:
  npm run preflight -- [--profile NAME] [--client claude|chatgpt] [--fix]
  npm run configure
  npm run bootstrap-state
  npm run deploy
  npm run set-password
  npm run smoke

Commands:
  preflight      Check the local tools, project, AWS identity, and client readiness.
  configure      Create terraform/terraform.tfvars from the safe example if needed.
  bootstrap-state Create or reconnect the protected S3 state backend.
  deploy         Build, plan, confirm, apply, seed, and set the owner password.
  set-password   Retry only the private Cognito owner-password step.
  smoke          Test authentication and the complete MCP note round trip.

No command prints Terraform secrets, access keys, bearer tokens, or passwords.`);
}

async function main(argv = process.argv.slice(2)) {
  const [command = "help", ...rest] = argv;
  if (["help", "-h", "--help"].includes(command)) {
    help();
    return;
  }
  const options = parseOptions(rest);
  if (command === "preflight") {
    const result = await preflight(options);
    if (!result.ok) process.exitCode = 1;
  } else if (command === "configure") {
    if (rest.length > 0) throw new CliError("configure does not accept options.", 2);
    configure();
  } else if (command === "bootstrap-state") {
    await bootstrapState(options);
  } else if (command === "deploy") {
    await deploy(options);
  } else if (command === "set-password") {
    if (rest.length > 0) throw new CliError("set-password does not accept options.", 2);
    assertDefaultWorkspaceOnly(TF_DIR, "Vault Brain");
    const readiness = await preflight({}, { strictConfig: true, skipClient: true, requireBackend: true });
    if (!readiness.ok) throw new CliError("Password setup stopped because preflight did not pass.");
    await setPermanentPassword(readiness);
  } else if (command === "smoke") {
    if (rest.length > 0) throw new CliError("smoke does not accept options.", 2);
    await smoke();
  } else {
    throw new CliError(`Unknown command: ${command}`, 2);
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`\n${colors.red("ERROR")} ${message}`);
    process.exitCode = error instanceof CliError ? error.exitCode : 1;
  });
}
