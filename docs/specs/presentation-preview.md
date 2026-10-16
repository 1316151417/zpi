# PowerPoint file preview

PPTX opens in a read-only document renderer based on ZCode's Apache-2.0 presentation preview. It uses @aiden0z/pptx-renderer 1.2.4, lazy ZIP media and lazy slide materialization; source bytes and OOXML are never executed as scripts.

- Show a scrollable thumbnail rail, a fit-to-viewport slide, and a bottom toolbar with page input, previous/next, 25–300% fit-relative zoom in 25% steps.
- Retain slide hyperlinks within the viewer; route only validated HTTP(S) external links through the existing host browser boundary.
- Support explicit element selection and optional AI-edit comments added to the existing conversation context. This does not send a message or mutate the file.
- Export PDF only through the desktop print/save bridge: render all slide pages, wait for fonts/images, use CSS page size and zero margins, free print DOM, then ask the user for a destination. Cancellation is not failure.
- Dispose renderer handles on page/document changes and unmount; observe thumbnail visibility so large decks do not render all slides eagerly.
- Empty, invalid, and failed documents have explicit states. Preview routing and maximum binary size are owned by the shared file preview boundary.

Acceptance: page limits and invalid input, keyboard navigation without intercepting inputs, zoom limits, shape/table hit testing, unsupported-link rejection, cancellation-safe cleanup, and real sample-deck render/export in the desktop harness.
