# Shortcut shutdown lifecycle fix — 2026-10-14

Version: 0.2.48. Base: main 132208875eda75bf4c984970b1e6ad7ccc105258 (0.2.47).

## Cause and fix

The user reported `Object has been destroyed` from `ShortcutController.ignoreMenuShortcuts` during `dispose`. The callback introduced with customizable shortcuts in 0.2.43 checked whether webContents was destroyed, but first accessed it through a BrowserWindow that could already have been destroyed. Normal shutdown permits window destruction before `will-quit` invokes controller disposal.

- Check BrowserWindow lifetime before reading its webContents, then check WebContents lifetime before restoring menu shortcuts.
- Keep controller disposal idempotent so repeated cleanup does not touch native objects twice.
- Apply the same early window guard to the adjacent pre-quit draft flush entry. Existing live-window flush behavior and exit sequencing are unchanged.
- Do not broadly catch or hide unexpected live-object errors.

## Reference and review

ZCode reference aac4755666d09fdcd70272fcf063c077a639015f follows the same two-layer lifecycle checks:

- [webRemoteControlStatusEvents.ts](https://github.com/zai-org/ZCode/blob/aac4755666d09fdcd70272fcf063c077a639015f/packages/desktop/src/main/webRemoteControlStatusEvents.ts#L15-L25)
- [desktopWindowChrome.ts](https://github.com/zai-org/ZCode/blob/aac4755666d09fdcd70272fcf063c077a639015f/packages/desktop/src/main/desktopWindowChrome.ts#L235-L241)
- [reference tests](https://github.com/zai-org/ZCode/blob/aac4755666d09fdcd70272fcf063c077a639015f/packages/desktop/src/main/webRemoteControlStatusEvents.test.ts#L38-L51)

Independent source review found no blocker in the minimal guard, disposal or adjacent lifecycle changes.

## Regression evidence

The test double throws from the webContents getter after window destruction. Temporarily removing the window guard produced three precise `Object has been destroyed` failures (direct access, disposal while recording, and disposal without recording). Restoring the guard passed all 30 focused controller tests. Coverage also includes destroyed contents in a live window, live menu restoration, repeated disposal, stale callbacks and propagation of unexpected live-object errors.

The adjacent draft-flush guard was statically reviewed, not separately exercised in Electron. No real macOS GUI or native application exit was executed; the user's computer was not accessed.

## Final checks

- npm run test:unit: 152 files passed, 1 skipped; 1174 tests passed, 2 skipped.
- npm run check: passed, with four existing CSS warnings.
- npm run build: passed.
- git diff --check: passed.
