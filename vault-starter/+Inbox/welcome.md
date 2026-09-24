---
type: capture
tags: [meta]
---

# Welcome to your vault

This note is sitting in `+Inbox/`, which means it has not been triaged yet. That is
on purpose: it gives your first session something real to do.

Ask your connected AI client to triage this note.

It should call `describe_schema` first to learn this vault's rules, then `list_inbox`
to see what is waiting, then either `move_note` this into `Notes/` or `trash_note` it.
Either answer is correct. The point is watching the loop work end to end.

Some things worth trying after that:

- "Capture this: ..." and then find it again with `search_vault`.
- "What is in my vault?" which should use `list_notes`, not read every note.
- Open Obsidian and confirm the same notes are there after Remotely Save syncs.

Once all three work, the stack is doing its job.
