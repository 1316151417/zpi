# File and diff preview alignment

The right pane follows the checked-out ZCode preview and SidePaneTabTrigger sources. Keep format support, comment ownership and safe headless operation unchanged.

## Rendering rules

- Diff file navigation owns its styles through the direct-child `diff-file-list` class. Nested preview breadcrumbs must not inherit its height limit, padding, border or overflow rules.
- File tab icon (14 px inside a 16 px slot), title and Diff badge share one horizontal fade. The selected, hovered or keyboard-focused tab reserves 20 px for its close button; titles do not independently ellipsize.
- The Diff badge and breadcrumb surface use the neutral fill token. ZCode's `surface` means a translucent neutral fill; ZPI's existing `surface` means an opaque panel, so token names cannot be copied literally.
- Code remains 12 px with the same platform monospace/CJK stack. Pierre File uses its 20 px line height; lightweight diffs use 1.625 (19.5 px). UI labels and comment text follow the application's UI-size tokens. Do not globally shrink UI text or add speculative font-smoothing overrides.
- Saved comment text uses 1.625 line height and a neutral delete action, matching the reference comment card.

## Selection ownership

FilePane controls Pierre's selectedLines. An active draft takes precedence over an explicit file-navigation line range. When neither exists, pass null, never undefined: Pierre 1.1.22 interprets undefined as uncontrolled and otherwise retains its internal drag selection. Submit and cancel clear the draft; validation failure retains it; location highlighting remains independent. Comments remain projected from the owning session's composer draft.

## Regression checks

- Pure rendering/callback tests cover initial empty selection, drag draft, cancel, submit, repeated comments and explicit navigation ranges.
- CSS contract tests cover the navigation boundary, consolidated code typography and shared tab fade/badge tokens.
- Desktop comment tests assert that selected-line markers disappear after submission, cancellation and deletion. These tests require an available desktop runtime; static checks are not visual or Electron verification.

## Reference audit

ZCode sources: `packages/ui/src/PreviewPane.tsx`, `app-shell/SidePaneTabTrigger.tsx`, `components/ui/code-viewer.tsx`, `components/ui/lightweight-diff-preview.tsx`, `lib/codePreviewSettings.ts`, and `styles.css`. Installed ZPI Pierre version is 1.1.22; reference declares ^1.1.22. Defaults are 12 px code / 14 px UI, normal code weight / 500 tab weight. Both source font stacks already match. No font-smoothing override was present in the inspected reference.
