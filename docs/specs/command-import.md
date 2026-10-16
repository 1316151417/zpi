# Explicit external command import

## Scope and reference

The settings command menu retains an explicit import dialog modeled on ZCode's `ExternalAgentImportDialog.tsx` and `settingsSyncService.ts`. Opening the dialog, or pressing its rescan button, starts discovery. App startup, opening command settings, refreshing the local command list, composing a message, and executing a command do not discover external agent command folders.

The selected command-settings scope determines the destination:

- User: `~/.zpi/commands`
- Project: `<registered-project>/.zpi/commands`

The main process supplies the trusted home, destination, and optional project directory. The renderer sends a project ID, never a source or destination path. Selecting a project provides global and project source-range choices. Cross-scope imports are intentional: a selected project's dialog can import a global source into that project's destination.

## Exact source set

| Agent | Global directory relative to home | Project directory relative to project |
| --- | --- | --- |
| Claude Code | `.claude/commands` | `.claude/commands` |
| Codex CLI | `.codex/commands` | `.codex/commands` |
| OpenCode | `.config/opencode/commands` | `.opencode/commands` |
| OpenClaw | `.openclaw/commands` | `commands` |
| Augment | `.augment/commands` | `.augment/commands` |
| Continue | `.continue/commands` | `.continue/commands` |
| Goose | `.config/goose/commands` | `.goose/commands` |
| Qwen Code | `.qwen/commands` | `.qwen/commands` |
| Qoder | `.qoder/commands` | `.qoder/commands` |
| Qoder CN | `.qoder-cn/commands` | `.qoder/commands` |
| Windsurf | `.codeium/windsurf/commands` | `.windsurf/commands` |
| Trae | `.trae/commands` | `.trae/commands` |
| Kiro CLI | `.kiro/commands` | `.kiro/commands` |
| Roo | `.roo/commands` | `.roo/commands` |
| CodeBuddy | `.codebuddy/commands` | `.codebuddy/commands` |

The shared Qoder project path is deduplicated. ZCode itself, `.agents`, Trae CN, Codex prompts, and skill/plugin folders are not command sources in the reference set and are not added here.

## Interaction

- Initial selection is empty; the default import method is symlink.
- Source rows expand to show individual commands, descriptions, and argument hints.
- Select all, whole-source selection, per-command selection, and mixed checkbox states are supported.
- Existing target files and case-insensitive command-name conflicts are hidden from the importable list and never overwritten.
- The import action is disabled until something is selected. Source-range selection does not change the settings-selected destination.
- Scanning, importing, empty, failure, and completion states are shown. Completion includes per-command status and imported/skipped/failed counts.
- Import failures leave their reason visible. Discovery warnings are available in a collapsible section. Rescanning clears the selection and returns to global source range.
- The modal uses the existing Radix components, theme tokens, focus management, 672 px width, 640 px/84 vh height, 16 px rounded corners, and scrollable bordered selection body.

## File and safety behavior

Only ordinary `.md` files are discovered. Nested paths remain nested, including command names such as `/tools/review`. Hidden files/directories, source file symlinks, and directory symlinks are not traversed. Every existing ancestor of home, project, source, and target is checked from the filesystem root. Source files are opened with `O_NOFOLLOW` where supported and identity is checked before and after reading.

Each source is bounded to 10,000 directory entries and nesting depth 8. An explicit scan is bounded to 1,000 command candidates and 16 MiB total content, with 256 KiB per command file, consistent with local command reading. Invalid portable relative filenames are rejected. Metadata uses the local command parser; command bodies and shell-looking text are never executed by discovery or import.

A discovery returns opaque candidate IDs plus revisions derived from file identity, timestamps, size, and content hash. The service retains at most eight scan snapshots. Import accepts only selections from one retained scan and verifies every selection and revision. It rechecks source safety and content revision immediately before copying/linking, and checks conflicts again. Concurrent imports are serialized within the importer.

Copy imports write and sync a hidden temporary file in the destination directory, publish it with an atomic no-clobber link, then remove the staging name. This prevents partially written commands from being visible and leaves the resulting copy with a single link. Conflicting files created during publication are preserved.

Symlink imports create a real file symlink and atomically persist the explicitly approved source path in the destination's hidden `.import-links.json` provenance registry. Local command storage accepts only matching registered links and validates their exact source files, without rediscovering external folders. Source changes are followed; source deletion, replacement by a symlink, or link retargeting fails closed. Editing a linked command uses the storage layer's separate source-edit confirmation. Deleting a linked command removes its local link only.

Windows deliberately does not reproduce ZCode's silent hard-link/copy substitution: an unavailable symlink privilege returns an actionable per-item error asking the user to select direct copy. Successful symlink imports have the same provenance checks on all platforms.

## API and ownership

- `new CommandImportService({ homeDirectory, targetDirectory, workspaceDirectory?, platform? })`
- `discover(): Promise<CommandImportDiscovery>`
- `importSelected(request: CommandImportRequest): Promise<CommandImportResult>`
- `registeredLinkTargets(): Promise<ReadonlyMap<string, string>>`
- Preload: `discoverCommandImports(projectId?)` and `importCommands(request, projectId?)`, both using the app's Result envelope
- UI: `CommandImportDialog({ projectId?, onClose, onImported })`

The importer owns provenance only; local command content, enablement state, execution, and source-edit confirmation remain owned by the command store/host.

## Verification

`npm run test:unit -- packages/desktop/test/command-import.test.ts` passes 21 temporary-directory tests. Coverage includes the exact 15-source set, separate global/project discovery, Qoder deduplication, metadata/nesting, unsupported destinations, symlink ancestors, oversized sources, selected byte-preserving copy, same-name/exact conflicts, stale/forged selections, changed or symlink-replaced sources, changed target directories, dangling-target conflicts, simultaneous imports, atomic publication races and cleanup, persisted provenance with local-store integration, retargeted links, malformed provenance paths, and Windows symlink permission failure without silent fallback.

These tests do not read the real home directory, execute imported command contents, launch Electron, or use live credentials. GUI integration and visual comparison belong to the parent integration task.
