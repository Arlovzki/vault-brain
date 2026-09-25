# Optional: capture coding-agent sessions in your vault

This bonus starter creates one small Markdown receipt per Claude Code or Codex session in your local Obsidian vault's `+Inbox/`. The first completed assistant turn creates it. Later turns never rewrite it, so your Obsidian edits are safe. It records only the client, approved project name, opaque session key, and capture time. It **does not** read transcripts, copy prompts, replies, or tool output, or produce an AI summary.

The script writes a local file. It does not call the Vault Brain MCP server or write to S3. Obsidian's Remotely Save plugin syncs that file to S3 when your vault sync runs. Review the note before sharing it or keeping it long term.

## Install only if you want this

1. Finish the main workshop first. Have Node.js 22 and a local Obsidian vault with the starter `+Inbox/` folder.
2. Open the [Claude Code example](claude-settings.example.json) or [Codex example](codex-hooks.example.json). Replace all three absolute paths: this cloned repo's script, your **local Obsidian vault folder**, and the one project root you approve for capture. The project root must already exist and cannot be your home folder or a filesystem root. On Windows, use forward-slash absolute paths such as `C:/Users/you/vault-brain`.
3. Manually merge the Claude snippet into your user-level `~/.claude/settings.json` and/or the Codex snippet into `~/.codex/hooks.json`. Do not overwrite existing settings or hooks. These user-level hooks are available across projects, but this example writes only when the active working directory is inside the approved project root. Add a separately reviewed entry for each additional project you want to allow. Cloning this repo alone enables nothing.
4. Review and trust the new hook in Codex using `/hooks`. Restart either client so it loads the changed configuration. Claude Code can inspect configured hooks with `/hooks`.
5. Complete a harmless test turn inside the approved project. Check `+Inbox/` for a note named like `YYYY-MM-DD-session-codex-project-<key>.md`. Then let Remotely Save sync and confirm the note appears on your second device.

The examples are **not active** in this repository. Cloning or deploying Vault Brain does not install either hook. An existing receipt is never read or overwritten by the script. Add your own summary directly in Obsidian, or ask a connected AI client to save a separate curated note through MCP.

Leave the receipt in `+Inbox/` until that coding session ends. If you move it mid-session, a later `Stop` can create another receipt.

**Codex path safety:** Codex evaluates the `command` string through a shell. Use this example only when all three configured paths contain letters, digits, spaces, `/`, `:`, `.`, `_`, or `-`. If a path contains any other character, do not use the example unchanged. Claude Code's example uses an argument array, which avoids shell re-parsing of its path arguments.

To stop capture, remove the hook entry from your user settings. Existing notes stay in your vault until you review or trash them.

References: [Claude Code hooks](https://code.claude.com/docs/en/hooks) and [Codex hooks](https://learn.chatgpt.com/docs/hooks).
