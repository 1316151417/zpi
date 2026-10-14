# Workspace, shortcut and task toolbar fixes — 2026-10-14

Version: 0.2.47. Base: main 2f1b79202f10fdcea06adafb30426d1fd4ea99eb (0.2.46).

## Changes

- Directory selection now starts at the current task's actual existing cwd (including worktrees), with the home directory as fallback. Renderer supplies a session ID, while Main resolves and validates the path. Cancellation leaves existing project/task behavior unchanged.
- Defaults: Command/Ctrl+J left sidebar, L right pane, K task search, semicolon model selection, I main task composer. One-time settings migration preserves custom/unbound shortcuts and the master switch; conflicting candidate maps retain the old map. A pre-existing I binding is preserved.
- Window show/hide retains valid native guest or DOM focus; only lost focus falls back to the current main composer. Explicit I focuses the main composer. Shared shortcut routing covers renderer and browser guests without copying DOM events with object spread.
- Group/project pills reuse the existing fill token matching ZCode light/dark surfaces, and restore hover foreground. The adjacent expand/collapse button remains visible and disabled when no groups exist, as explicitly requested.
- Updated specs, README, development guidance, site defaults and affected desktop scenarios. No dependencies added.

## Reference verification

ZCode reference: aac4755666d09fdcd70272fcf063c077a639015f.

- ZCode directory IPC does not provide defaultPath: [source](https://github.com/zai-org/ZCode/blob/aac4755666d09fdcd70272fcf063c077a639015f/packages/desktop/src/main/desktopMainIpcPlatform.ts#L123-L130).
- Both Electron 41.0.3 (reference) and 41.10.7 (ZPI) leave an empty defaultPath to the native macOS panel. Neither version hardcodes Downloads in that path: [41.0.3](https://github.com/electron/electron/blob/v41.0.3/shell/browser/ui/file_dialog_mac.mm#L189-L219), [41.10.7](https://github.com/electron/electron/blob/v41.10.7/shell/browser/ui/file_dialog_mac.mm#L189-L219).
- The user's Downloads observation is valid; source inspection cannot establish why their native panel chose it. Explicit current-task/home defaults are a ZPI improvement rather than a claim of ZCode parity.
- ZCode hides the all-groups control when no groups exist; retaining a disabled control is the user's requested adaptation. Pill dimensions and theme tokens were compared with source rather than copied from inactive-window screenshot colors.

## Verification

- npm run test:unit: 152 files passed, 1 skipped; 1167 tests passed, 2 skipped.
- npm run check: passed; four pre-existing CSS important warnings.
- npm run build: passed.
- git diff --check: passed.
- Independent shortcut/focus integration review: no confirmed blocker; 169 focused tests passed separately.
- Picker and toolbar focused tests passed; new toolbar desktop scenarios were collected successfully.

All executed tests were cloud Node checks without opening the user's applications. Actual macOS global shortcut registration, cross-application/native guest focus restoration, native panel starting directory, and visual/pixel behavior were not exercised in a real GUI. Desktop Playwright scenarios are included but not reported as passed.
