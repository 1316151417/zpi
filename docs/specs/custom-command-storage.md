# User custom-command storage

## Scope and owner

`CustomCommandsStore` is the desktop-main owner for the explicitly injected command directory
(production: `~/.zpi/commands` or a validated project’s `.zpi/commands`) and a separate enabled-state JSON
file. It does not discover a home,
workspace, another framework, or plugins. IPC passes relative command IDs, never arbitrary paths.
The storage constructor is an internal trusted-main API.

## Contract

- List Markdown files recursively, omitting dotfiles. `tools/review.md` is `/tools/review`.
  Names compare case-insensitively: create/rename conflicts are rejected, while existing duplicate
  names select the first deterministic alphabetical entry and report diagnostics without deleting files.
  Existing names outside the slash-invocation grammar remain editable with an invocation diagnostic.
- Commands are enabled by default; disabled IDs persist atomically in the injected state file.
- Metadata includes the relative ID, display name, source path, prompt, description, argument hint,
  enabled state, and a SHA-256 content revision. List returns actionable diagnostics for skipped files.
- Create and rename accept one ASCII component of 1–50 letters, numbers, underscores, or hyphens.
  Existing safe nested names can be edited without renaming.
- Update and delete require the listed revision, so a stale editor cannot silently replace newer content.
- Only an opening `---` fence is frontmatter. Description and argument-hint support scalar and indented
  multiline values. Unknown frontmatter lines survive edits. Prompt contents remain inert text.
- Flat `skills` metadata supports a scalar, comma list, or bracketed list (at most 64 names, 128
  characters per name). `disable-noninteractive` recognizes true/yes and remains distinct from the
  persisted enabled preference. Both are preserved when editing description/prompt fields. These are
  inert metadata: the session owner resolves skill names and controls slash-catalog visibility.
  Model and allowed-tools metadata is preserved but not applied by storage.
- No argument expansion, shell execution, or dependency on another agent framework is added here.

## Filesystem safety and failures

All ancestors, the root, state file, command directories, and command files are checked without following
symlinks. Relative IDs reject traversal, absolute paths, backslashes, empty/dot/hidden components, control
characters, and non-Markdown files. Reads use a no-follow file handle, regular-file checks and byte limits.
Scanning has entry, depth, file-count and total-byte budgets. Listings are deterministic and alphabetical.

Only links recorded by the separate explicit importer may be read: its trusted callback maps a relative ID
to the exact approved absolute source file. The link must still match that path; the source and every
ancestor must be regular/non-symlink as appropriate. No source directory is scanned. Editing such a link
requires `confirmLinkedSource: true`, the exact `expectedSourcePath`, and the
source content revision. It atomically replaces that source file and retains the local link. The UI must
disclose the source destination before approval. Linked names cannot be renamed during a source edit.
Deleting removes only the local link. If a registered source disappears, becomes malformed, or is
otherwise unsafe to read, its local link remains listed as unreadable and effectively disabled. A
link-target revision permits deleting that local link without reading its source. Source recovery
restores the persisted enable preference.

Mutations run serially in one store. Writes stage and sync a private same-directory file before publishing.
Creation and rename use an atomic no-overwrite link. In-place updates publish with atomic rename; errors
before publication preserve the original. Rename publishes the new file before removing the old and rolls
back the new file if removing the old fails. Disabled-state migration retains the old ID until successful
recreation; stale overrides are harmless and bounded. Invalid state is reported and never overwritten.

These checks reject existing malicious paths and revalidate before publication. Portable Node filesystem
APIs do not provide directory-handle-relative `openat`/`renameat` or an atomic compare-and-swap rename;
an actively hostile process replacing ancestor directories or editing a file in the final check-to-rename
window is outside this store's guarantee. Root/state paths must be controlled by the application/user.

## Acceptance coverage

Isolated temporary directories cover create/update/rename/delete, persisted enable state, nested names,
unknown frontmatter and multiline values, deterministic discovery, bounded scans, stale revisions,
conflicting targets, invalid IDs, root/ancestor/directory/file/state symlinks, registered links, serialized
mutations, corrupted state, and preservation of the old file when a staged write/publish fails.
