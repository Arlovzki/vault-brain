# Bonus: save a coding-session receipt

This optional hook leaves a small note in your Obsidian vault when you use Claude Code or Codex. It is useful if you want to remember **which project you worked on**, not what the AI said.

**One completed coding turn → a note in local `+Inbox/` → Obsidian sync → the same note in S3**

The note records the client, project name, session key, and time. It does not save your prompts, replies, tool output, or transcript, and it is **not a summary**. To preserve a decision or a useful result, write a separate note in Obsidian or ask a connected AI client to save one through Vault Brain MCP.

The hook writes to your **local** vault only. Remotely Save sends the note to S3 when you sync. The hook itself does not call MCP or AWS.

## Set it up after the main workshop

1. Check that Node.js 22 is installed and your local Obsidian vault has the starter `+Inbox/` folder.
2. Open the [Claude Code example](claude-settings.example.json) or [Codex example](codex-hooks.example.json). Replace these three placeholder paths with absolute paths on your computer:

   - The `capture.mjs` script in your cloned `vault-brain` repository.
   - Your **local Obsidian vault folder**, not its S3 bucket.
   - The one project folder where you allow the hook to run. This folder must already exist. Do not use your home folder or a filesystem root.

   On Windows, use forward slashes, for example `C:/Users/you/vault-brain`.

3. Add the example to your existing settings. **Merge it; do not replace the whole file or remove hooks you already have.**

   - Claude Code: use `~/.claude/settings.json`, then restart. You can inspect its hooks with `/hooks`.
   - Codex: use `~/.codex/hooks.json`, then restart and open `/hooks` to review and trust the new hook.

4. Complete one harmless coding turn inside your approved project. Look for a file like `YYYY-MM-DD-session-codex-project-<key>.md` in your local `+Inbox/`. Sync Obsidian with Remotely Save, then check that the note appears in the S3-backed vault.

Cloning or deploying Vault Brain does **not** install these hooks. Nothing runs until you edit your settings and enable the example yourself.

## What to expect

- The first completed turn creates one receipt for that session. Later turns leave it alone, so you can edit the note in Obsidian without the hook overwriting it.
- Keep the receipt in `+Inbox/` until the session ends. Moving it during the session can cause a later turn to create a second receipt.
- The hook runs from user-level settings, but writes only while your working directory is inside the approved project. Review and add a separate entry if you want to allow another project.
- To stop, remove the hook entry from your settings. Notes already created remain in your vault until you move or trash them.

**Codex path safety:** Codex runs the example `command` through a shell. Use the example unchanged only if all three configured paths contain letters, digits, spaces, `/`, `:`, `.`, `_`, or `-`. If a path contains another character, do not use this example unchanged. Claude Code passes its paths as separate arguments.

References: [Claude Code hooks](https://code.claude.com/docs/en/hooks) and [Codex hooks](https://learn.chatgpt.com/docs/hooks).
