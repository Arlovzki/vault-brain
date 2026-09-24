import {
  S3Client,
  PutObjectCommand,
  ListObjectsV2Command,
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
  CopyObjectCommand,
} from "@aws-sdk/client-s3";

import { localDay } from "./day.js";

const VAULT_BUCKET = process.env.VAULT_BUCKET ?? "";
const MAX_KEY_BYTES = 512;
const MAX_LIST_RESULTS = 500;
const MAX_SEARCH_RESULTS = 100;
const MAX_SEARCH_QUERY_LENGTH = 500;
const MAX_GRAPH_NOTES = 2000;

// The note holding the vault's conventions. describe_schema returns it verbatim so a
// client can learn the rules with one tool call instead of being prompted with them.
const SCHEMA_KEY = "System/schema.md";

const s3 = new S3Client({});

export interface Tool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<string>;
}

function slug(s: string): string {
  const out = s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return out.length > 0 ? out : "note";
}

async function bodyToString(body: unknown): Promise<string> {
  const b = body as { transformToString?: () => Promise<string> } | undefined;
  if (b && typeof b.transformToString === "function") return b.transformToString();
  return "";
}

// Trim leading slashes so callers can pass "/Foo.md" or "Foo.md" interchangeably,
// then reject anything that could escape the vault. Without this a caller could write
// a key like "../.obsidian/plugins/x/main.js", which Remotely Save materializes OUTSIDE
// the vault folder on the owner's disk. Throwing surfaces as a clean tool error (every
// handler runs inside the dispatcher's try/catch).
function normalizeKey(p: unknown): string {
  const key = String(p ?? "").replace(/^\/+/, "").trim();
  if (key.length === 0) return "";
  if (Buffer.byteLength(key, "utf8") > MAX_KEY_BYTES) {
    throw new Error(`invalid path (maximum ${MAX_KEY_BYTES} UTF-8 bytes)`);
  }
  if (key.includes("\\") || key.includes("\0")) {
    throw new Error(`invalid path (backslashes and null bytes are not allowed): ${key}`);
  }
  if (/^[a-zA-Z]:/.test(key)) {
    throw new Error(`invalid path (absolute paths are not allowed): ${key}`);
  }
  const segments = key.split("/");
  if (
    segments.some(
      (seg, index) => (seg.length === 0 && index !== segments.length - 1) || seg === "." || seg === "..",
    )
  ) {
    throw new Error(`invalid path (internal empty, ".", and ".." segments are not allowed): ${key}`);
  }
  return key;
}

// Parse a caller-supplied count, falling back to `def` for anything non-finite.
// Guards against Number("all") === NaN silently disabling a result loop or slice.
function clampInt(v: unknown, def: number, max: number): number {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n >= 1 ? Math.min(n, max) : def;
}

function pathSegments(key: string): string[] {
  return key.split("/").map((segment) => segment.toLowerCase());
}

function isRootFolder(key: string, folder: string): boolean {
  return pathSegments(key)[0] === folder.toLowerCase();
}

function isBlockedNamespace(key: string): boolean {
  const segments = pathSegments(key);
  const root = segments[0] ?? "";
  return segments.includes(".obsidian") || (root.startsWith(".") && root !== ".trash");
}

function assertAccessibleNamespace(key: string, action: string): void {
  const segments = pathSegments(key);
  if (segments.includes(".obsidian")) {
    throw new Error(`${key} is Obsidian configuration and cannot be accessed via ${action}.`);
  }
  const root = segments[0] ?? "";
  if (root.startsWith(".") && root !== ".trash") {
    throw new Error(`${key} is in a hidden vault namespace and cannot be accessed via ${action}.`);
  }
}

function assertMarkdownNote(key: string, action: string): void {
  if (!key.toLowerCase().endsWith(".md")) {
    throw new Error(`${action} only accepts Markdown note paths ending in .md`);
  }
  assertAccessibleNamespace(key, action);
}

function assertNonSystemNote(key: string, action: string): void {
  assertMarkdownNote(key, action);
  if (isRootFolder(key, "System")) {
    throw new Error(
      `${key} is in the owner-managed System folder and cannot be changed via ${action}. Edit it directly in Obsidian.`,
    );
  }
}

function assertWritableNote(key: string, action: string): void {
  assertNonSystemNote(key, action);
  if (isRootFolder(key, ".trash")) {
    throw new Error(`${key} is in the managed trash folder and cannot be changed via ${action}.`);
  }
}

async function getText(key: string): Promise<string> {
  const res = await s3.send(new GetObjectCommand({ Bucket: VAULT_BUCKET, Key: key }));
  return bodyToString(res.Body);
}

// One place for the "does this key exist" check, so the not-found error-name list
// cannot drift across the tools that use it.
async function exists(key: string): Promise<boolean> {
  try {
    await s3.send(new HeadObjectCommand({ Bucket: VAULT_BUCKET, Key: key }));
    return true;
  } catch (e) {
    const name = (e as { name?: string })?.name;
    if (name === "NotFound" || name === "NoSuchKey") return false;
    throw e;
  }
}

// CopySource for a server-side copy: bytes never round-trip through Lambda (so
// non-UTF-8 files are not corrupted) and each segment is encoded so spaces and
// unicode in filenames survive.
function copySource(key: string): string {
  return `${VAULT_BUCKET}/${key.split("/").map(encodeURIComponent).join("/")}`;
}

interface VaultObject {
  key: string;
  size: number;
  modified: number;
}

// Every .md object in the vault (paginated, since S3 caps a list page at 1000).
// A listing already carries Size and LastModified, so list_notes gets both for
// free: one call per 1000 notes and not a single body read. That is the whole
// difference between it and search_vault, which must GET every note.
async function listAllObjects(prefix?: string): Promise<VaultObject[]> {
  const out: VaultObject[] = [];
  let token: string | undefined;
  do {
    const res = await s3.send(
      new ListObjectsV2Command({ Bucket: VAULT_BUCKET, Prefix: prefix, ContinuationToken: token }),
    );
    for (const o of res.Contents ?? []) {
      if (
        typeof o.Key === "string" &&
        o.Key.toLowerCase().endsWith(".md") &&
        !isBlockedNamespace(o.Key)
      ) {
        out.push({ key: o.Key, size: o.Size ?? 0, modified: o.LastModified?.getTime() ?? 0 });
      }
    }
    token = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (token);
  return out;
}

async function listAllKeys(prefix?: string): Promise<string[]> {
  return (await listAllObjects(prefix)).map((o) => o.key);
}

function humanBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

// Bounded-concurrency map so a search does not fire hundreds of GETs at once.
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (t: T, idx: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (let idx = i++; idx < items.length; idx = i++) {
      results[idx] = await fn(items[idx] as T, idx);
    }
  });
  await Promise.all(workers);
  return results;
}

export const tools: Tool[] = [
  {
    name: "describe_schema",
    description:
      "Read the vault's conventions: its folders, capture and triage rules, filename and frontmatter format, and how deletion and linking work. Takes no arguments. Call this once at the start of a session, before writing or filing anything, so notes land where the vault owner expects them.",
    inputSchema: { type: "object", properties: {} },
    handler: async () => {
      try {
        const text = await getText(SCHEMA_KEY);
        return text.length > 0 ? text : `(${SCHEMA_KEY} is empty)`;
      } catch {
        return `No ${SCHEMA_KEY} in this vault yet, so it has no declared conventions. Default to capturing into +Inbox/ and ask the owner before inventing a folder structure.`;
      }
    },
  },
  {
    name: "capture",
    description:
      "Capture a note into the vault. Defaults to the +Inbox to sort later; pass folder to file it directly (e.g. 'Notes', 'Sources'). Optional tags and source are written into the note's frontmatter. Writes a Markdown file to the vault.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "The note content (Markdown)." },
        title: { type: "string", description: "Optional short title; becomes the filename." },
        folder: {
          type: "string",
          description: "Target folder (default '+Inbox'). E.g. 'Notes' for evergreen notes, 'Sources' for references.",
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "Optional frontmatter tags.",
        },
        source: {
          type: "string",
          description: "Optional source/reference for frontmatter, e.g. a URL or 'MCP conversation'.",
        },
      },
      required: ["text"],
    },
    handler: async (args) => {
      const text = String(args.text ?? "");
      const now = new Date();
      // The note's created/updated are a day in the owner's life, so the vault's
      // local day (day.ts, VAULT_TZ), not UTC. The fallback title's timestamp stays UTC-ISO.
      const date = localDay();
      const title = args.title ? String(args.title) : `capture ${now.toISOString().slice(0, 16)}`;

      const folder = (normalizeKey(args.folder ?? "+Inbox").replace(/\/+$/, "")) || "+Inbox";
      let key = normalizeKey(`${folder}/${date}-${slug(title)}.md`);
      assertWritableNote(key, "capture");
      // Two same-day captures with the same title would resolve to the same key and the
      // second would silently overwrite the first. If the key is taken, disambiguate
      // with a time suffix rather than destroying the earlier note.
      if (await exists(key)) {
        const stamp = now.toISOString().slice(11, 19).replace(/:/g, "");
        key = normalizeKey(`${folder}/${date}-${slug(title)}-${stamp}.md`);
      }

      // Accept tags as an array or a comma/space-separated string.
      let tags: string[] = [];
      if (Array.isArray(args.tags)) {
        tags = args.tags.map((t) => String(t).trim()).filter(Boolean);
      } else if (typeof args.tags === "string") {
        tags = args.tags.split(/[,\s]+/).map((t) => t.trim()).filter(Boolean);
      }

      const fm = ["---", "type: capture", `created: ${date}`, `updated: ${date}`];
      if (args.source) fm.push(`source: ${JSON.stringify(String(args.source))}`);
      if (tags.length) fm.push(`tags: ${JSON.stringify(tags)}`);
      fm.push("---");
      const md = `${fm.join("\n")}\n\n# ${title}\n\n${text}\n`;

      await s3.send(
        new PutObjectCommand({
          Bucket: VAULT_BUCKET,
          Key: key,
          Body: md,
          ContentType: "text/markdown",
        }),
      );
      return `Captured to ${key}`;
    },
  },
  {
    name: "list_inbox",
    description: "List up to 500 notes currently in the vault's +Inbox waiting to be sorted.",
    inputSchema: { type: "object", properties: {} },
    handler: async () => {
      const keys = await listAllKeys("+Inbox/");
      if (keys.length === 0) return "(inbox empty)";
      const shown = keys.slice(0, MAX_LIST_RESULTS);
      const note = keys.length > shown.length ? `\n(showing ${shown.length} of ${keys.length} notes)` : "";
      return `${shown.join("\n")}${note}`;
    },
  },
  {
    name: "list_notes",
    description:
      "List notes in the vault with their size and last-modified day, optionally scoped to a folder. Reads no note bodies at all, so it stays cheap on a large vault and is the right way to see what exists before reaching for read_note. Use search_vault instead when you need to find text INSIDE notes; use this when you need the shape of the vault: what is in a folder, what changed recently, or what is unusually large.",
    inputSchema: {
      type: "object",
      properties: {
        prefix: {
          type: "string",
          description: "Optional folder to scope the listing, e.g. 'Notes/' or 'Sources/'.",
        },
        sort: {
          type: "string",
          description: "'path' (default, alphabetical), 'modified' for newest first, or 'size' for largest first.",
        },
        max_results: { type: "number", description: "Max notes to list (default 200)." },
      },
    },
    handler: async (args) => {
      const prefix = args.prefix ? normalizeKey(args.prefix) : undefined;
      if (prefix) assertAccessibleNamespace(prefix, "list_notes");
      const sort = String(args.sort ?? "path");
      if (!["path", "modified", "size"].includes(sort))
        return "Error: sort must be 'path', 'modified' or 'size'.";
      const maxResults = clampInt(args.max_results, 200, MAX_LIST_RESULTS);

      const objects = await listAllObjects(prefix);
      if (objects.length === 0)
        return prefix ? `No notes under ${prefix}` : "No notes in the vault.";

      const totalBytes = objects.reduce((n, o) => n + o.size, 0);
      const sorted = [...objects].sort((a, b) =>
        sort === "modified"
          ? b.modified - a.modified
          : sort === "size"
            ? b.size - a.size
            : a.key.localeCompare(b.key),
      );
      const shown = sorted.slice(0, maxResults);

      // Pad to the widest path shown so sizes and dates line up as columns, but
      // cap it so one deep path cannot push the dates off the far right.
      const width = Math.min(72, Math.max(...shown.map((o) => o.key.length)));
      const rows = shown.map(
        (o) => `  ${o.key.padEnd(width)}  ${humanBytes(o.size).padStart(8)}  ${localDay(o.modified)}`,
      );

      const scope = prefix ? ` under ${prefix}` : "";
      const trunc =
        objects.length > shown.length ? `; showing the first ${shown.length} by ${sort}` : "";
      return `${objects.length} note(s)${scope}, ${humanBytes(totalBytes)} total${trunc}:\n\n${rows.join("\n")}`;
    },
  },
  {
    name: "read_note",
    description: "Read a note from the vault by its path (key), e.g. 'System/schema.md'.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string", description: "Vault-relative path to the note." } },
      required: ["path"],
    },
    handler: async (args) => {
      const key = normalizeKey(args.path);
      if (!key) return "Error: path is required.";
      assertMarkdownNote(key, "read_note");
      const res = await s3.send(new GetObjectCommand({ Bucket: VAULT_BUCKET, Key: key }));
      const text = await bodyToString(res.Body);
      return text.length > 0 ? text : "(empty)";
    },
  },
  {
    name: "search_vault",
    description:
      "Search notes in the vault for a case-insensitive text substring and return matching notes with line numbers and snippets. Optionally scope to a folder with prefix. Use this to find notes before reading or editing them.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Text substring to find." },
        prefix: { type: "string", description: "Optional folder to scope the search, e.g. 'Notes/'." },
        max_results: { type: "number", description: "Max matching notes to return (default 20)." },
      },
      required: ["query"],
    },
    handler: async (args) => {
      const query = String(args.query ?? "");
      if (!query) return "Error: query is required.";
      if (query.length > MAX_SEARCH_QUERY_LENGTH) {
        return `Error: query must be at most ${MAX_SEARCH_QUERY_LENGTH} characters.`;
      }
      const prefix = args.prefix ? normalizeKey(args.prefix) : undefined;
      if (prefix) assertAccessibleNamespace(prefix, "search_vault");
      const maxResults = clampInt(args.max_results, 20, MAX_SEARCH_RESULTS);
      const needle = query.toLowerCase();

      const SCAN_CAP = 2000;
      const MAX_NOTE_BYTES = 1_000_000;
      const all = await listAllObjects(prefix);
      // Skip pathologically large objects (a multi-MB note is never a useful text hit,
      // and reading many full bodies at once is what OOMs a small function).
      const sizeFiltered = all.filter((o) => o.size <= MAX_NOTE_BYTES);
      const skippedLarge = all.length - sizeFiltered.length;
      const objects = sizeFiltered.slice(0, SCAN_CAP);

      // Scan each body inside its worker and keep only the matching lines, so peak
      // memory is bounded by the concurrency (a dozen bodies) rather than every body
      // at once. Results are placed by index to keep stable (S3 lexical) order, and
      // once the cap is reached remaining workers skip their GET entirely.
      const found: (string | null)[] = new Array(objects.length).fill(null);
      let matched = 0;
      await mapLimit(objects, 12, async (o, idx) => {
        if (matched >= maxResults) return;
        const text = await getText(o.key).catch(() => "");
        if (matched >= maxResults) return;
        const lines = text.split(/\r?\n/);
        const hits: string[] = [];
        for (let ln = 0; ln < lines.length && hits.length < 5; ln++) {
          const line = lines[ln] ?? "";
          const isHit = line.toLowerCase().includes(needle);
          if (isHit) hits.push(`  ${ln + 1}: ${line.trim().slice(0, 200)}`);
        }
        if (hits.length > 0) {
          matched++;
          found[idx] = `${o.key}\n${hits.join("\n")}`;
        }
      });

      const out = found.filter((x): x is string => x !== null).slice(0, maxResults);
      if (out.length === 0) return `No matches for ${JSON.stringify(query)} across ${all.length} notes.`;
      const notes: string[] = [];
      if (sizeFiltered.length > SCAN_CAP) notes.push(`scanned first ${SCAN_CAP} of ${sizeFiltered.length} notes`);
      if (skippedLarge > 0) notes.push(`${skippedLarge} oversized note(s) skipped`);
      const trunc = notes.length > 0 ? ` (${notes.join("; ")})` : "";
      return `${out.length} note(s) matched${trunc}:\n\n${out.join("\n\n")}`;
    },
  },
  {
    name: "edit_note",
    description:
      "Edit an existing note by replacing an exact snippet of its text. Reads the note, swaps `find` for `replace`, and writes it back. Fails if `find` is absent, or if it occurs more than once and replace_all is not set. Read the note or search_vault first to copy the exact snippet.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Vault-relative path, e.g. 'Notes/foo.md'." },
        find: { type: "string", description: "Exact text to replace (must exist in the note)." },
        replace: { type: "string", description: "Replacement text." },
        replace_all: {
          type: "boolean",
          description: "Replace every occurrence (default false: replaces one, erroring if not unique).",
        },
      },
      required: ["path", "find", "replace"],
    },
    handler: async (args) => {
      const key = normalizeKey(args.path);
      const find = String(args.find ?? "");
      const replace = String(args.replace ?? "");
      const replaceAll = Boolean(args.replace_all);
      if (!key) return "Error: path is required.";
      if (!find) return "Error: find is required.";
      assertWritableNote(key, "edit_note");

      let text: string;
      try {
        text = await getText(key);
      } catch {
        return `Error: note not found: ${key}`;
      }

      const parts = text.split(find);
      const count = parts.length - 1;
      if (count === 0)
        return `Error: the snippet was not found in ${key}. Read the note or search first to copy the exact text.`;
      if (count > 1 && !replaceAll)
        return `Error: the snippet appears ${count} times in ${key}. Pass replace_all:true, or use a longer, unique snippet.`;

      // split/join instead of String.replace to avoid regex and $-pattern interpretation.
      const updated = replaceAll ? parts.join(replace) : parts[0] + replace + parts.slice(1).join(find);
      await s3.send(
        new PutObjectCommand({
          Bucket: VAULT_BUCKET,
          Key: key,
          Body: updated,
          ContentType: "text/markdown",
        }),
      );
      const n = replaceAll ? count : 1;
      return `Edited ${key} (${n} replacement${n === 1 ? "" : "s"}).`;
    },
  },
  {
    name: "write_note",
    description:
      "Create a new note (or overwrite an existing one) at an exact path with full Markdown content. Fails if the note already exists unless overwrite:true. For quick, unsorted captures use `capture` instead; for a small change to an existing note use `edit_note`.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Vault-relative path ending in .md, e.g. 'Notes/foo.md'." },
        content: { type: "string", description: "Full Markdown content of the note." },
        overwrite: { type: "boolean", description: "Overwrite if the note already exists (default false)." },
      },
      required: ["path", "content"],
    },
    handler: async (args) => {
      const key = normalizeKey(args.path);
      const content = String(args.content ?? "");
      const overwrite = Boolean(args.overwrite);
      if (!key) return "Error: path is required.";
      assertWritableNote(key, "write_note");

      if (!overwrite && (await exists(key))) {
        return `Error: ${key} already exists. Pass overwrite:true to replace it, or use edit_note for a surgical change.`;
      }
      await s3.send(
        new PutObjectCommand({
          Bucket: VAULT_BUCKET,
          Key: key,
          Body: content,
          ContentType: "text/markdown",
        }),
      );
      return `Wrote ${key} (${content.length} bytes).`;
    },
  },
  {
    name: "move_note",
    description:
      "Move or rename a note to a new path. This is the one relocate tool: a new filename in the same folder is a rename, a new folder is a move, and moving into an Archive folder is an archive. Copies the note to `to`, then deletes the old key. Fails if `from` is missing, or if `to` already exists unless overwrite:true. It does NOT rewrite `[[wikilinks]]` that referenced the old name, so fix those separately (search_vault for the old basename).",
    inputSchema: {
      type: "object",
      properties: {
        from: { type: "string", description: "Current vault-relative path, e.g. '+Inbox/2026-08-30-idea.md'." },
        to: { type: "string", description: "New vault-relative path ending in .md, e.g. 'Notes/idea.md'." },
        overwrite: { type: "boolean", description: "Overwrite if `to` already exists (default false)." },
      },
      required: ["from", "to"],
    },
    handler: async (args) => {
      const from = normalizeKey(args.from);
      const to = normalizeKey(args.to);
      const overwrite = Boolean(args.overwrite);
      if (!from) return "Error: from is required.";
      if (!to) return "Error: to is required.";
      if (from === to) return "Error: from and to are the same path.";
      assertNonSystemNote(from, "move_note");
      assertWritableNote(to, "move_note");

      if (!(await exists(from))) return `Error: note not found: ${from}`;
      if (!overwrite && (await exists(to))) {
        return `Error: ${to} already exists. Pass overwrite:true to replace it.`;
      }

      // Server-side copy keeps the note bytes out of Lambda and preserves the
      // source content type.
      await s3.send(
        new CopyObjectCommand({ Bucket: VAULT_BUCKET, Key: to, CopySource: copySource(from) }),
      );
      await s3.send(new DeleteObjectCommand({ Bucket: VAULT_BUCKET, Key: from }));
      return `Moved ${from} to ${to}. Any [[wikilinks]] to the old name are not rewritten.`;
    },
  },
  {
    name: "trash_note",
    description:
      "Soft-delete a note by moving it into the vault's `.trash/` folder, timestamped so it never collides. Recoverable: move_note it back out. Prefer this over delete_note whenever you are not certain the note should be gone for good.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string", description: "Vault-relative path of the note to trash." } },
      required: ["path"],
    },
    handler: async (args) => {
      const key = normalizeKey(args.path);
      if (!key) return "Error: path is required.";
      assertWritableNote(key, "trash_note");
      if (!(await exists(key))) return `Error: note not found: ${key}`;
      const base = key.split("/").pop() || key;
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const dest = normalizeKey(`.trash/${stamp}-${base}`);
      // Server-side copy keeps the note bytes out of Lambda.
      await s3.send(
        new CopyObjectCommand({ Bucket: VAULT_BUCKET, Key: dest, CopySource: copySource(key) }),
      );
      await s3.send(new DeleteObjectCommand({ Bucket: VAULT_BUCKET, Key: key }));
      return `Trashed ${key} to ${dest}. Recover it with move_note if needed.`;
    },
  },
  {
    name: "delete_note",
    description:
      "Permanently delete a note from the vault (removes the file). There is no in-vault undo, though the vault bucket is versioned so a delete can still be recovered from S3 version history. Prefer trash_note for a recoverable soft delete; use delete_note only when the note should truly be gone.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string", description: "Vault-relative path of the note to delete." } },
      required: ["path"],
    },
    handler: async (args) => {
      const key = normalizeKey(args.path);
      if (!key) return "Error: path is required.";
      assertNonSystemNote(key, "delete_note");
      if (!(await exists(key))) return `Error: note not found: ${key}`;
      await s3.send(new DeleteObjectCommand({ Bucket: VAULT_BUCKET, Key: key }));
      return `Deleted ${key} permanently. It can still be recovered from the versioned bucket's history.`;
    },
  },
  {
    name: "find_orphans",
    description:
      "Graph-hygiene sweep: report notes with no inbound [[wikilink]] (orphans) and links whose target note does not exist (dangling links). Notes in +Inbox/ (staging), System/ (rules), and .trash/ are not counted as orphans. Scans at most 2,000 notes, so run it as a periodic check, not on every write.",
    inputSchema: { type: "object", properties: {} },
    handler: async () => {
      const eligible = (await listAllObjects()).filter(
        (o) => !isRootFolder(o.key, ".trash") && o.size <= 1_000_000,
      );
      const all = eligible.slice(0, MAX_GRAPH_NOTES);
      const scanNote =
        eligible.length > all.length
          ? ` Scanned the first ${all.length} of ${eligible.length} eligible notes.`
          : "";
      const basename = (key: string) =>
        (key.split("/").pop() ?? key).replace(/\.md$/i, "").toLowerCase();

      // Include every listed note in resolution, even when its body falls beyond the
      // scan cap, so links to an unscanned note are not reported as dangling.
      const existing = new Set(eligible.map((o) => basename(o.key)));

      // Scan link sources for [[targets]]. The rules note is skipped: its `[[wikilinks]]`
      // is documentation, not a real link. A fresh regex per body avoids the shared
      // lastIndex races that a single /g regex would hit under concurrency.
      const sources = all.filter((o) => !isRootFolder(o.key, "System"));
      const scanned = await mapLimit(sources, 12, async (o) => {
        const text = await getText(o.key).catch(() => "");
        const targets = new Set<string>();
        for (const m of text.matchAll(/\[\[([^\]]+)\]\]/g)) {
          const raw = (m[1] ?? "").split("|")[0]?.split("#")[0]?.trim().replace(/\.md$/i, "").toLowerCase();
          if (raw) targets.add(raw);
        }
        return { key: o.key, targets: [...targets] };
      });

      // target basename -> set of note keys that link to it.
      const inbound = new Map<string, Set<string>>();
      const dangling: string[] = [];
      for (const s of scanned) {
        for (const t of s.targets) {
          if (!inbound.has(t)) inbound.set(t, new Set());
          (inbound.get(t) as Set<string>).add(s.key);
          if (!existing.has(t)) dangling.push(`${s.key} -> [[${t}]]`);
        }
      }

      // Orphans: candidates (not inbox/System/trash) that nothing OTHER than themselves links.
      const candidates = all.filter(
        (o) => !isRootFolder(o.key, "+Inbox") && !isRootFolder(o.key, "System"),
      );
      const orphans = candidates
        .filter((o) => {
          const linkers = inbound.get(basename(o.key));
          return !linkers || (linkers.size === 1 && linkers.has(o.key));
        })
        .map((o) => o.key)
        .sort();

      const dedupDangling = Array.from(new Set(dangling)).sort();
      if (orphans.length === 0 && dedupDangling.length === 0) {
        return `No orphans and no dangling links across ${all.length} scanned notes.${scanNote}`;
      }
      const orphanBlock =
        orphans.length > 0
          ? `Orphans (no inbound [[link]]): ${orphans.length}\n${orphans.map((k) => `  ${k}`).join("\n")}`
          : "Orphans: none.";
      const danglingBlock =
        dedupDangling.length > 0
          ? `Dangling links (target note missing): ${dedupDangling.length}\n${dedupDangling.map((d) => `  ${d}`).join("\n")}`
          : "Dangling links: none.";
      return `${orphanBlock}\n\n${danglingBlock}${scanNote}`;
    },
  },
];
