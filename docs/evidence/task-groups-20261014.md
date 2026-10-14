# Task groups implementation and validation — 2026-10-14

## Reference and scope

The reference is ZCode commit `aac4755666d09fdcd70272fcf063c077a639015f`, inspected from source rather than relying on its older grouped-view specification.

- Current toolbar: `packages/ui/src/WorkspaceSidebar.tsx:1220–1318`, Group / Project pill, with Timeline in the Project filter. Group mode has its own manual order.
- Group interaction and rename/color focus: `packages/ui/src/workspace-grouped-tasks/group-item.tsx`.
- Movement rules: `workspace-grouped-tasks/view.ts:313–560` and `WorkspaceGroupedTasksSection.tsx:209–359,1480–1533`.
- Geometry and palette: `workspace-grouped-tasks/types.ts:17–47`, `colors.tsx:6–20`. Header 32px, task line 28px, wrapper 32px, group color mark 20px with a 12px Hash, menu dots 10px, content inset 16px + 1px rail + 8px.
- Virtualization: `virtualized-top-level-list.tsx` and `virtualized-group-task-list.tsx`: threshold above 80 items, overscan 12. Group title remains accessible at the top while its expanded content is scrolled. ZPI uses native sticky positioning in its existing unmasked scroller rather than a duplicate overlay header.
- Pointer behavior: primary left pointer, 6px activation; movement direction, including reversal over the same target, determines before/after. Group drag temporarily collapses the group; cancellation restores the original layout. Hidden collapsing content is inert and is not a drop target.
- Collapse: 200ms grid/opacity transition, then content unmount. Reduced-motion preference disables the transition.

## Architecture and compatibility

ZPI stores group definitions, one membership per task, and mixed root order in an atomically replaced `task-groups.json`. Existing session records, message histories and working directories remain unchanged. Old installations without the file initially show existing tasks at root in creation order. New public sessions, including forks, initialize at the top without moving older manually ordered tasks.

Group mutations operate on the complete authoritative structure. Pinned and archived tasks retain membership/order even while hidden. Ungrouping replaces a group with its members and never deletes sessions. Unlike the reference's separate order-save/delete steps, this operation is one atomic group-file write. Creating a grouped draft commits placement with session creation and removes the new session/index if group persistence fails. Permanent session deletion prunes persisted group references.

The existing store owns renderer data. IPC validates commands. Grouped New task and the configurable New task shortcut share the same draft-reuse path; drafts are keyed by project and group. Pinned shortcuts use the same visible-pinned ordering as the sidebar in every view. Project/Timeline preferences, global task search and independent pane ownership remain intact.

## Product boundaries

No scheduling, off-peak execution, remote workspaces, workflow system or automatic legacy workspace grouping is introduced. ZCode's optional file-tree action only appears when its file-tree callback exists; ZPI currently has no equivalent workspace file-tree pane, so this optional action is not displayed. Native-agent log, provider-file and feedback-system menu entries likewise depend on capabilities absent from ZPI and are not fabricated. Existing ZPI running-task archive protection is retained.

The seven colors are the reference Tailwind palette values, expressed in CSS, and icons reuse the installed Lucide package. There are no copied bitmap assets. Apache-2.0 provenance and the actual Lucide ISC / Feather MIT notices are included in `THIRD_PARTY_NOTICES.md`.

## Validation

The final validation runs TypeScript/Biome, focused regressions, the full unit/service suite, and the production build sequentially. Unit/service coverage includes:

- Legacy tasks, duplicate/blank group names, group colors and restart persistence
- Root/group mixed order, cross-group movement, same-parent move-to-top and ungroup without task loss
- Pinned/archive restoration and permanent deletion
- Failed group writes and session-creation rollback
- Drag direction reversal over the same target, header/footer/collapsed/empty targets, primary-pointer filtering, and hidden drop-target/tooltip suppression
- Hydration-safe collapsed preferences, stale renderer refresh protection, grouped draft reuse and pinned/new-task shortcut integration
- Refreshing hover change counts after updates and after failed reads

Three hidden-Electron regression scenarios are added in `tests/desktop/task-groups.spec.ts`: group menus/IME/colors/reload, virtualized long lists/sticky headers/drafts, and grouped-view shortcut integration. They are type-checked but have **not been executed** in this cloud environment. GUI launch was blocked by the environment's Unix-socket restrictions for X/Chromium; no user computer was accessed and no screenshots or pixel-by-pixel comparison were produced. Consequently this record does not claim runtime-verified pixel-perfect parity.

Final local results for the v0.2.44 integrated code (`51fcec8`, including v0.2.43 shortcuts):

- `npm run check`: passed; four existing `noImportantStyles` warnings remain in the shared UI stylesheet.
- Focused grouping/store/shortcut regression run: 5 files, 94 tests passed.
- `npm run test:unit`: 144 files passed, 1 skipped; 1,019 tests passed, 2 skipped.
- `npm run build`: passed (main, preload, renderer); existing upstream `use client` bundler warnings remain.
- `git diff --check`: passed.
- Hidden Electron / Chromium GUI and screenshots: blocked, not counted as passed.

The follow-up commit adding this evidence changes documentation only; application code is identical to the tested commit.
