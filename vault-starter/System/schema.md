---
type: system
---

# Vault schema

The conventions of this vault. `describe_schema` returns this note verbatim, so this
is what an assistant reads before it writes anything. Edit it and the rules change:
there is no second copy anywhere in the code.

This note is the vault's rules and is owner-controlled. Edit it directly in Obsidian.
The MCP server refuses to write, move, or delete `System/schema.md`, so the rules
cannot be rewritten by a tool call (which would otherwise let anything an assistant
was handed rewrite the instructions every later session reads).

## Folders

- `+Inbox/` unsorted captures land here. Everything in it is waiting to be triaged.
- `Notes/` evergreen notes, written in the owner's own words.
- `Sources/` external references: articles, videos, books, papers. What someone else said.
- `System/` rules about the vault, not content. This note lives here.
- `.trash/` soft-deleted notes, timestamped. Recoverable with `move_note`.

Add folders when a real need appears, not in advance. Ask the owner before inventing
a new top-level folder.

## Capturing

Quick thoughts go through `capture`, which lands them in `+Inbox/` untriaged. That is
the default and it is the right one when the destination is not obvious.

File directly (pass `folder`) only when the destination is genuinely clear: an article
the owner is saving goes to `Sources/`, a worked-out idea in their own words goes to
`Notes/`.

Filenames are `YYYY-MM-DD-slug.md`, where the date is the vault's local day, not UTC.
`capture` builds this; when using `write_note` directly, match it.

Frontmatter, as `capture` writes it:

```
---
type: capture
created: "YYYY-MM-DD"
updated: "YYYY-MM-DD"
source: "https://example.com/article"   # optional
tags: [idea, reading]                    # optional
---
```

## Triaging

Emptying the inbox is the recurring job. `list_inbox` shows what is waiting.
For each note: `move_note` it into `Notes/` or `Sources/`, or trash it. Rename it on
the way out if the capture title was a placeholder, since `move_note` renames and
moves in one step.

A note that has been read and is not worth keeping should be trashed, not left in the
inbox. An inbox that never empties stops being an inbox.

## Deleting

Prefer `trash_note`. It moves the note into `.trash/` with a timestamp and is
recoverable with `move_note`.

`delete_note` is permanent. The bucket is versioned, so a delete can still be undone
from S3 version history for 30 days, but that is a recovery procedure, not an undo
button. Use it only when the note should truly be gone.

## Linking

Notes link to each other with `[[wikilinks]]`, matching the note's basename without
the `.md`.

`move_note` does NOT rewrite links pointing at the old name. After any rename, run
`search_vault` for the old basename and fix what it finds.

## Graph hygiene

No note should be orphaned: every note in `Notes/` and `Sources/` should be reachable
by at least one `[[wikilink]]` from another note. When you add or file a note, link it
from a related note (or a relevant index note). Notes in `+Inbox/` are exempt while they
wait to be triaged, and `System/` is exempt (it is rules, not content).

Run `find_orphans` to list notes with no inbound links, plus links whose target note is
missing (dangling links). Fix what it reports: link the orphan in, or trash it if it is
not worth keeping; and repoint or remove a dangling link.

## Reading before writing

`list_notes` shows the shape of the vault (paths, sizes, modified dates) and reads no
bodies, so it is cheap. `search_vault` reads every note and finds text inside them.
Reach for `list_notes` to see what exists, `search_vault` to find what a note says.

Before adding a note on a topic, search for it. A vault with three notes on the same
idea is worse than one good note that got edited twice.
