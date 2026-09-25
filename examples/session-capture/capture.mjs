#!/usr/bin/env node
// Optional Claude Code / Codex Stop hook. Never reads a transcript or calls AWS.
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const MAX_INPUT_BYTES = 2 * 1024 * 1024;

function option(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function localDate(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function slug(value) {
  return String(value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 32) || "workspace";
}

async function readInput() {
  let size = 0;
  const chunks = [];
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > MAX_INPUT_BYTES) return null;
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return null;
  }
}

function capture(hook) {
  const client = option("--client");
  if (client !== "claude-code" && client !== "codex") throw new Error("Pass --client claude-code or --client codex.");
  if (hook?.hook_event_name !== "Stop" || typeof hook.session_id !== "string" || !hook.session_id.trim() || hook.session_id.length > 256) return;

  const allowedInput = option("--allow-root");
  if (!allowedInput || !path.isAbsolute(allowedInput)) throw new Error("Set --allow-root to an absolute project directory.");
  const allowedRoot = realpathSync(allowedInput);
  if (!statSync(allowedRoot).isDirectory() || allowedRoot === path.parse(allowedRoot).root || allowedRoot === realpathSync(os.homedir())) {
    throw new Error("The allowed project root must be an existing directory narrower than your home directory.");
  }
  if (typeof hook.cwd !== "string" || !path.isAbsolute(hook.cwd)) return;
  const cwd = realpathSync(hook.cwd);
  if (!statSync(cwd).isDirectory()) return;
  const relativeCwd = path.relative(allowedRoot, cwd);
  if (relativeCwd === ".." || relativeCwd.startsWith(`..${path.sep}`) || path.isAbsolute(relativeCwd)) return;

  const vaultInput = option("--vault");
  if (!vaultInput || !path.isAbsolute(vaultInput)) throw new Error("Set --vault to an absolute local Obsidian vault path.");
  const vault = realpathSync(vaultInput);
  if (vault === path.parse(vault).root || !statSync(vault).isDirectory()) throw new Error("The vault must be an existing directory, not a filesystem root.");
  const inbox = path.join(vault, "+Inbox");
  if (!existsSync(inbox) || !lstatSync(inbox).isDirectory()) throw new Error("The vault must already contain a real +Inbox/ directory; no folders were created.");

  const project = path.basename(allowedRoot) || "workspace";
  const displayProject = project.replace(/[^A-Za-z0-9 _.-]/g, " ").trim() || "workspace";
  const key = createHash("sha256").update(hook.session_id).digest("hex").slice(0, 12);
  const suffix = `-session-${client}-${slug(project)}-${key}.md`;
  const existingName = readdirSync(inbox).find((name) => /^\d{4}-\d{2}-\d{2}-/.test(name) && name.endsWith(suffix));
  if (existingName) return;
  const today = localDate();
  const notePath = path.join(inbox, `${today}${suffix}`);
  const label = client === "codex" ? "Codex" : "Claude Code";

  const body = `---\ntype: capture\ncreated: "${today}"\nupdated: "${today}"\ntags: [session, ${client}]\n---\n\n# ${label} session in ${displayProject}\n\nThis is a local metadata-only session receipt, not an AI summary or a full transcript.\n\n- Client: ${label}\n- Project: ${displayProject}\n- Session key: ${key}\n- Captured: ${new Date().toISOString()}\n\nAdd your own summary here, or ask a connected client to create a separate curated note through MCP.\n`;
  writeFileSync(notePath, body, { encoding: "utf8", mode: 0o600, flag: "wx" });
}

try {
  const hook = await readInput();
  if (hook) capture(hook);
} catch (error) {
  // A capture failure must not derail the agent. Never print the hook payload.
  process.stderr.write(`Vault capture skipped: ${error.message}\n`);
}
