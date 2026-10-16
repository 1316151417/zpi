# Custom commands

## Product contract

The Commands settings page and composer slash picker follow ZCode reference `aac4755666d09fdcd70272fcf063c077a639015f`. Custom command files live in user `~/.zpi/commands` and project `${projectDir}/.zpi/commands` (user confirmed both scopes). Ordinary discovery never reads another framework directory. Settings bind to the selected existing project ID, while execution binds to the submitting session working directory; project names shadow user names even when disabled. Existing built-in `/init` and `/compact` and skill handling remain separate. Removed `/side` and `/btw` are not restored.

Settings use a scope/count/search toolbar, installed count, overflow import action, refresh and New. Rows use Terminal icons, command name, optional argument hint, description and persisted enabled switch. Clicking the row opens an inline editor; toggling does not edit. The editor has name, description, argument hint and required prompt. Editing locks the name/scope. Save returns to the list; cancel writes nothing; deletion requires confirmation. Search matches name/description/prompt case-insensitively and counts the filtered result. Operation errors remain visible and must not close a failed editor.

An explicit import action opens source discovery and selection, matching the reference source groups, copy/symlink modes, conflict skipping and result step. Opening ordinary settings or the composer does not scan import sources. Imported symlinks require a persisted verified source grant; arbitrary links are never followed.

## Ownership and safety

Electron main owns file discovery, validation, persistent enabled state and import source grants. Renderer only owns unsaved form fields, filters and selection. Every mutation uses bounded validated input, server-owned paths and revision checks. Tests use injected temporary HOME roots. Filesystem changes are reflected on manual refresh, window focus and before invocation. Invocation resolves against the submitting session, never a later selected task, and retains original slash text in visible history. Custom expansion is part of desktop input preparation; coding-agent core stays independent.

## Acceptance

- Empty/list/search/count/create/edit/cancel/delete confirmation and failed-save retention.
- Disabled commands survive restart and are absent from suggestions and execution.
- External edits refresh, stale edits cannot overwrite newer bytes, duplicate create/import cannot overwrite.
- Traversal, arbitrary symlinks, malformed input, missing files and oversized scans produce safe feedback.
- Slash picker styles, groups, fuzzy sorting, insertion and keyboard behavior match source; selection does not send.
- Existing built-in commands and skills retain their behavior; no removed side commands return.
- Full TypeScript/Biome, unit suite, build and desktop test safety/collection required. Cloud GUI sandbox restrictions must be reported; collection is not a pixel acceptance pass.

## Explicit invocation and Shell templates

Sending a custom command may execute its inline `!`-backtick or fenced `!` Shell snippets, matching the actual desktop runtime. Discovery, preview, import, suggestions and queue admission never execute them. Queue dispatch resolves the current command for its owning session; arguments are substituted once, and argument text cannot introduce new executable template delimiters. Snippets execute sequentially through the existing Bash operations backend with session cwd, 30-second timeout, 128-KiB output budget, process-tree cancellation and separate stdout/error handling. Shell commands are prepared once per accepted run, outside provider retries. A preparation run is visible and cancellable; failure does not automatically rerun side effects. No additional tools or desktop dependencies enter the coding-agent core: only an optional stdout/stderr discriminator is added to its existing generic output callback.

`skills` metadata loads explicitly named skills through the session's existing enabled resource loader before invoking the template. `disable-noninteractive` hides the command from suggestions but preserves explicit invocation. `model` and `allowed-tools` remain preserved metadata; the reference invocation route does not actually apply those overrides.

Internally delegated subagent inputs and subagent notifications never interpret user command templates or Agent mentions; tool-restricted profiles cannot use template interpolation to bypass their tool allowlist.
