# Terminal presentation

The side pane terminal matches ZCode's terminal surface: no extra cwd heading, 12 px padding,
13 px default monospace text, normal/bold xterm weights, line height 1, and a non-blinking block
cursor (outline when inactive). Terminal typography is independent of the application's UI font size.
The tab title is the workspace path leaf, with ` 2`, ` 3`, etc. for additional open terminals in the
same owning conversation. The full cwd remains available as the pane tooltip.

Light and dark ANSI palettes and selections follow ZCode. App background, foreground and cursor
remain readable when switching themes. On macOS, read-only native terminal profile detection can
supply font family, font size, ANSI colors and selection; it never changes shell startup files,
prompts, native terminal preferences, or application appearance. Invalid/missing profile fields use
the defaults. Automated test mode skips native profile reads entirely. Detection is shared and cached
for the current application process/home; restarting the app refreshes native preferences. A closed
window/service must never start a PTY when an outstanding profile read completes. Profile metadata belongs to the existing terminal tab and does not create a second PTY.

Existing input/copy shortcuts, HTTP links, resize, focus guards, output replay, close/session cleanup
and PTY ownership remain in their existing owners. Switching visible tabs must not recreate the PTY.

Acceptance: no path heading; workspace-numbered tabs; fixed typography through UI-size changes;
light/dark readable base colors with inherited ANSI preserved; safe missing/corrupt profile fallback;
input and resize still work and close disposes the terminal. Unit tests cover presentation and profile
parsing, and the isolated desktop fixture covers visible chrome and terminal interaction. GUI execution
requires a supported isolated desktop environment; collection is not visual verification.
