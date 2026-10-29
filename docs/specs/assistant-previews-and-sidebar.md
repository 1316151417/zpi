# Assistant previews and sidebar

Preview parsing and presentation are adapted from ZCode commit `872ad960de7ec172591f7e1952f7849229f94521` (Apache-2.0). Attribution and licenses remain in [THIRD_PARTY_NOTICES.md](../../THIRD_PARTY_NOTICES.md). Sidebar behavior is maintained in [task-list-sidebar.md](task-list-sidebar.md) and [task-groups.md](task-groups.md); this document covers automatic assistant previews.

## Preview rules

- Join a turn's assistant text blocks with two newlines. Show cards after the last text block, before message actions, once the turn stops running. Interrupted output can still produce cards.
- Supported files are Markdown, HTML, DOCX, XLSX, PPTX, PDF, and the audio/video formats in `packages/ui/src/preview/media-preview.ts`. Images and plain text do not become automatic cards.
- Parse citation directives, Markdown links, file URLs, balanced quoted paths, and ordinary paths. Citation ranges and code blocks must not leak into fallback path extraction. Keep Windows paths, encoded file URLs and line/column suffixes covered by tests.
- Markdown and HTML require an active file change in the same turn. A bare filename can match only one changed leaf. Failed change reads produce no such cards. Office, PDF and media files do not require a turn change.
- Website cards accept only valid HTTP(S) localhost or 127.0.0.1 URLs, without credentials. Preserve routes, queries and fragments; do not probe connectivity. Accepted website previews suppress HTML-file cards. Website candidates tied to a changed HTML file still require that file to exist.
- Sort candidates by descending text position, deduplicate normalized paths/URLs, validate at most 15 candidates and display at most 10. File validation accepts existing regular files only.
- Deduplicate concurrent identical validations by session, run and content signature. Discard late results for another scope. Remounting historical content rechecks file existence.
- Automatically open the final visible PPTX only after observing a running turn complete successfully in the current conversation. Consume each session/run/final-PPTX signature once. Restored history and interrupted turns do not trigger automatic opening.
- File actions share the existing preview/open/reveal/copy handlers. Website cards can open in the client preview or the user's browser. Respect reduced-motion preferences.

## Ownership

`packages/ui/src/preview/` owns pure parsing and validation rules. It has no filesystem or Electron access. `AssistantPreviewCards` renders cards and consumes injected services.

Desktop `preview-services.ts` connects turn changes and batched file checks to preload/IPC. Main owns filesystem checks. The existing pane store owns opening files and websites; requests remain scoped to the originating session. Core and SDK tools do not gain browser-control capabilities.

## Validation

Use the normal [development checks](../development.md#测试), plus focused coverage when changing these rules:

- `packages/ui/test/assistant-preview-cards.test.ts`: path grammar, priority, deduplication, validation limits and request lifecycle.
- `packages/desktop/test/preview-files.test.ts`: existing-file checks and supported filesystem inputs.
- `tests/desktop/preview-sidebar.spec.ts`: actual renderer/preload/main preview integration.
- `scripts/verify-preview-sidebar.mjs` and `scripts/verify-preview-assets.mjs`: optional source/visual/packaged-asset comparisons against a local ZCode checkout. Results stay in `release/preview-sidebar-parity/`.

Historical screenshots and test counts live in Git history. They do not establish current platform or release acceptance.
