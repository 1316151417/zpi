# File and diff preview alignment

The right pane follows the checked-out ZCode preview and SidePaneTabTrigger sources. Keep format support, comment ownership and safe headless operation unchanged.

## Rendering rules

- Opening a path from the conversation change summary creates a single-file preview. Its entries and search index contain every change entry for that exact path, never sibling paths from the same run. An absent path on an aggregate changes tab retains the existing all-files navigation and cross-file search.
- A change tab is identified by session, run (including task-wide scope), source kind (aggregate or tool operation), and path. Reopening the same source reuses its tab; another file, run, session, or tool operation stays independent. Existing in-memory tabs are matched by their source fields, including legacy IDs, without a new persistence layer.
- Tool previews read their operation patch, not the cumulative run patch. A missing tool path may be recovered from that operation; if unavailable, show a scoped error rather than all run changes. Streaming selection remains stable through completion.
- Async results belong to the source that requested them. Switching path/run/session clears the old source immediately; late results cannot replace the new source. Missing or deleted files do not select a sibling file. Historical patches can still display after a file is deleted.
- Diff file navigation owns its styles through the direct-child `diff-file-list` class. Nested preview breadcrumbs must not inherit its height limit, padding, border or overflow rules.
- File tab icon (14 px inside a 16 px slot), title and Diff badge share one horizontal fade. The selected, hovered or keyboard-focused tab reserves 20 px for its close button; titles do not independently ellipsize.
- The Diff badge and breadcrumb surface use the neutral fill token. ZCode's `surface` means a translucent neutral fill; ZPI's existing `surface` means an opaque panel, so token names cannot be copied literally.
- Code remains 12 px with the same platform monospace/CJK stack. Pierre File uses its 20 px line height; lightweight diffs use 1.625 (19.5 px). UI labels and comment text follow the application's UI-size tokens. Do not globally shrink UI text or add speculative font-smoothing overrides.
- Saved comment text uses 1.625 line height and a neutral delete action, matching the reference comment card.

## Selection ownership

FilePane controls Pierre's selectedLines. An active draft takes precedence over an explicit file-navigation line range. When neither exists, pass null, never undefined: Pierre 1.1.22 interprets undefined as uncontrolled and otherwise retains its internal drag selection. Submit and cancel clear the draft; validation failure retains it; location highlighting remains independent. Comments remain projected from the owning session's composer draft.

## Regression checks

- Real React DOM composition covers ChangedFiles → pane store → ChangesPane → DiffView/PreviewHeader: four-file summary, independent/reused tabs, all-files navigation and search, single-file search isolation, deferred patch reads, legacy in-memory tab restoration, missing/deleted paths, tool/aggregate separation, and late results after source changes. OS/editor/clipboard calls use fake IPC boundaries; DOM tests do not establish pixel or Electron parity.
- Pure rendering/callback tests cover initial empty selection, drag draft, cancel, submit, repeated comments and explicit navigation ranges.
- CSS contract tests cover the navigation boundary, consolidated code typography and shared tab fade/badge tokens.
- Desktop comment tests assert that selected-line markers disappear after submission, cancellation and deletion. These tests require an available desktop runtime; static checks are not visual or Electron verification.

## Reference audit

ZCode sources: `packages/ui/src/PreviewPane.tsx`, `app-shell/SidePaneTabTrigger.tsx`, `components/ui/code-viewer.tsx`, `components/ui/lightweight-diff-preview.tsx`, `lib/codePreviewSettings.ts`, and `styles.css`. Installed ZPI Pierre version is 1.1.22; reference declares ^1.1.22. Defaults are 12 px code / 14 px UI, normal code weight / 500 tab weight. Both source font stacks already match. No font-smoothing override was present in the inspected reference.
