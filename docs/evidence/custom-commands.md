# Custom commands implementation evidence

## Scope and baseline

The isolated `feat/zcode-commands` worktree integrates released main
`57145c8de74b1b8dc7ca1b9beb440c577928b188` (0.2.74). Local development commits
`bbc304f` and `6ac5d90` preserve the initial work and baseline merge. After explicit approval, root package/lock versions are 0.2.75 and the final local
commit is prepared for publication. Remote publication and main synchronization are
performed separately. No user-machine operation was performed for this task.

Reference: ZCode `aac4755666d09fdcd70272fcf063c077a639015f` and the supplied Commands
settings screenshot. Attribution and licensing are recorded in `THIRD_PARTY_NOTICES.md`.

## Delivered behavior

- User/project scope, counts, name/description/prompt search, persistent switches,
  Terminal cards, create/edit forms, titlebar breadcrumbs, refresh, deletion confirmation,
  and explicit import source/candidate/mode/results interaction.
- Ordinary roots are only `~/.zpi/commands` and the owning project's `.zpi/commands`.
  Project names shadow user names, even when disabled. Explicit imports scan the reference
  source list only when opened; they never auto-import or execute discovered content.
- Registered imported links share their source. Saving displays the resolved source and requires
  confirmation; deleting unlinks only the local entry. Broken registered links remain removable.
- Slash groups are Commands, Skills, Subagents. Fuzzy search, group order, initial selection,
  clamped arrows, Enter/Tab insertion, Escape, canonical chips, and descriptions use the reference
  interaction. Suggestions refresh for main and auxiliary sessions on changes/focus.
- Existing init/compact and canonical skills remain available. Removed side/btw remain absent.
  Subagent entries use enabled existing profiles and effective session capability snapshots;
  insertion is `@name` and explicit sending uses the existing Agent tool/profile contract.
- Frontmatter preserves unknown fields and supports description, argument hint, required skills,
  and disable-noninteractive. Nested slash names and colon aliases are callable.
- Explicit user dispatch expands arguments once and executes existing template shell segments
  sequentially in the submitting session through the current Bash backend. Queue admission,
  settings, scanning and selection cannot execute them. Preparation is cancellable, bounded by
  timeout/output limits, and reused across provider retries. Internal Agent delegation and
  notifications never interpret user command templates or Agent mentions.
- Preparation rejects both changed revisions and commands that appear/disappear between reads,
  preventing late-discovered shell execution before acceptance. Required skills use the owning
  session's enabled resource loader. Subagent capability/profile availability is rechecked.

## Verification

- `npm run check`: passed; 4 pre-existing CSS warnings and 6 informational diagnostics remain.
- `npm run test:unit`: 218 files passed, 1 skipped; 1952 tests passed, 2 skipped.
- `npm run build`: passed (existing dependency directive warnings).
- `npm run test:safety`: passed.
- `npx playwright test --list`: 177 tests in 78 files collected, including three isolated custom-command
  integration scenarios. Collection is not GUI execution.
- Independent review reran the five key command files: 102 tests passed. All identified blocking
  findings (nested identifiers, unusable links, non-atomic import copies, ancestor validation,
  missing session refresh, internal-delegation shell bypass, and preparation appearance race)
  were fixed and reviewed.
- `git diff --check`: passed. Shell execution tests inject mocks; filesystem fixtures use temporary
  roots. No real third-party command templates were executed.

## Boundaries and remaining validation

The cloud worktree has no installed Electron executable or Xvfb; GUI tests and pixel comparison
were not run. Source/screenshot alignment is implemented but is not certified pixel-perfect.
A real desktop run is still needed for visual acceptance and native window behavior.

Intentional safety behavior includes bounded scans/reads, path validation, stale-edit checks,
atomic publication and explicit linked-source save confirmation. Windows uses actual symlinks
and reports missing link privileges instead of silently creating hard links. Portable Node
filesystem APIs do not eliminate hostile final-check-to-rename ancestor replacement races; see
`docs/specs/custom-command-storage.md`. No claim of a filesystem sandbox or race-proof storage
is made. External edits are reloaded on refresh/focus and before invocation, not via a background
filesystem watcher. Existing ZPI models, permissions, skills and Agent tooling are reused;
frontmatter does not introduce new model/tool-permission overrides or plugin sources.
