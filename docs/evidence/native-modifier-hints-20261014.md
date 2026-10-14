# Native pinned-shortcut modifier state — 2026-10-14

Version: 0.2.50. Base: main fa28d0090e7cc54ea2a8b42935fbf5bd8be145f0 (0.2.49).

## User report and confirmed gap

The user reported that pressing Command alone did not show pinned hints, Command+1–5 did show them, and releasing Command did not clear them. The previous observer only read renderer keydown/keyup metaKey. Native browser guests did not forward modifier state or keyUp to the shell; its tests used synthetic DOM events and did not verify macOS modifier-only delivery.

Source inspection did not find a main-window filter or React shim that proves where the user's events were lost. Therefore this change is a native event-routing/state fix, not a claim that the user's actual macOS flagsChanged path has been reproduced.

## Changes

- A single Main ShortcutModifier observes before-input-event for shell and browser guests and publishes state through a separate preload subscription. Remove the old DOM keyboard state owner to avoid competing asynchronous states.
- Explicit left/right primary modifier down/up transitions take precedence over flags, including down with meta=false and up with meta=true. Keep the other held modifier active when one is released; ordinary key flags can reconcile state.
- Do not consume key events or dispatch shortcut commands. Publish only changed state, avoiding IPC for ordinary typing/repeats.
- BrowserWindow blur/hide/minimize clears state. Only the active input source's loading/crash/destruction clears its state; background guest activity cannot clear a held host modifier. Internal WebContents focus changes retain the held-key set. Host reload/crash resets globally because it replaces the IPC consumer even if a guest last owned input.
- Guest hide/close, settings disable/recording transitions and shutdown cleanup are covered. Preload unsubscribe removes its listener.

Independent review caught a background-guest reset regression during development; the source-scoped reset and its regression test are included in the final change.

## Evidence and limitations

- Electron 41.10.7 documents before-input-event as keyDown/keyUp before page and menu dispatch: https://github.com/electron/electron/blob/v41.10.7/docs/api/web-contents.md#event-before-input-event
- Electron's implementation still depends on Chromium keyboard delivery; it is not an independent OS modifier hook: https://github.com/electron/electron/blob/v41.10.7/shell/browser/api/electron_api_web_contents.cc
- Electron DEPS fixes Chromium 146.0.7680.216. Its Cocoa code distinguishes flagsChanged from performKeyEquivalent; source inspection alone does not establish the user's failure location: https://github.com/chromium/chromium/blob/146.0.7680.216/content/app_shim_remote_cocoa/render_widget_host_view_cocoa.mm

Focused regression: 4 files, 56 tests passed. Coverage uses Electron Input shapes, host/guest event emitters and preload integration, including modifier-only transitions, stale flags, both sides, internal focus transfer, lifecycle and listener cleanup.

No real macOS GUI or physical keyboard run was performed, and no user computer was accessed. Target-platform manual acceptance steps are in docs/specs/shortcuts.md. If upstream modifier events are absent entirely, this bridge cannot synthesize physical state; actual machine verification remains necessary.

## Final verification

- Full suite with --maxWorkers=2: 157 files passed, 1 skipped; 1211 tests passed, 2 skipped.
- The first final parallel run hit two process timing assertions in background-task-host/default-file-open. Both files passed isolated (19 tests), then the entire unchanged suite passed with two workers. Those unrelated tests were not modified.
- npm run check passed, with four pre-existing CSS warnings.
- npm run build and git diff --check passed.
- Independent source/lifecycle review found no remaining blocking code issue. Real macOS modifier-only acceptance remains unexecuted.
