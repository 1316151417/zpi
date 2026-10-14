# Held-modifier pinned task hints — 2026-10-14

Version: 0.2.49. Base: main b2e0bbad4a217ef5127b0a1075a4a1c16be10ee7 (0.2.48).

## Requested behavior

The user showed shortcut hints rendered beside different-width relative times, making them misaligned. Implement the interaction the user described from Codex: normally show the time, and while Command is held show the pinned task shortcut in that same right-aligned position. Other platforms use Ctrl. This is based on the requested interaction, not a claim that Codex source was inspected.

## Implementation

- Reuse the visible pinned order and actual shortcut settings/formatter for the first five task commands. Disabled or unbound commands do not invent a default hint.
- Observe modifier state without consuming input. Release, window blur and visibility changes clear the transient state; remove listeners on unmount.
- Reuse the existing time slot rather than adding a neighboring key label. During display, hints remain visible on row hover instead of switching to the archive button; normal hover behavior resumes after release.
- Preserve actionable pending-question badges. Only time is replaced; question state and controls remain unchanged.
- Update the existing desktop shortcut scenario to expect hidden-by-default, held-to-show and release-to-hide behavior.

## Review and boundaries

Independent review checked dispatch/display order, custom bindings, disabled/null configuration, modifier lifecycle, CSS hover precedence and question badge priority; no blocker remained.

The observer is renderer-local, including terminal input. A native browser guest that does not deliver key events to the renderer cannot reliably show held hints; no IPC was expanded. Restoring a window while Command is already held updates on the next renderer keyboard event. These boundaries are documented in the shortcut spec.

No user computer or real GUI was used. Node tests validate state and markup; visual/native interaction has not been represented as executed. The private screenshot is not committed.

## Additional user-requested changes in this batch

- Shortcut settings now reuse the existing settings-switch structure from other settings pages, rather than a native unstyled checkbox. Draft, disabled-while-recording/busy and save behavior remain unchanged.
- The explanation had an undefined settings-help class and inherited dark body text. Reuse settings-hint theme tokens for secondary text and split the instructions into two paragraphs with local spacing.
- Workspace picker now prefers the selected task's bound project root, including worktree tasks and hidden projects. Reuse the internal listProjects method with an optional includeHidden flag; ordinary callers retain the existing visible-only list. Unbound tasks retain their actual cwd; invalid candidates fall back home. Runtime cwd is not changed.
- Real SessionHost regression cases exercise project drafts, custom/worktree cwd, hidden projects, restored drafts, unbound tasks and invalid paths. The synthetic stale cwd case is not claimed as the cause of the user's report.

The user clarified the unwanted directory was ZPI's source checkout, not Documents/ZPI. Source inspection found no process.cwd fallback in this picker or its normal startup workspace configuration. Without the affected task's project association, the precise reported case remains unconfirmed; a task actually bound to the ZPI project legitimately resolves to its source checkout. The project-root rule is corrected, but this record does not claim the user's exact native-dialog case was reproduced.

## Final verification

- npm run test:unit: 155 files passed, 1 skipped; 1194 tests passed, 2 skipped.
- npm run check: passed; four pre-existing CSS important warnings.
- npm run build and git diff --check: passed.
- Earlier intermediate full run hit the known 0.2-second bash producer startup timing test (PID undefined); the isolated file and a subsequent full run passed without changing that test. Final complete batch passed as above.
- No real GUI or macOS native directory dialog validation was run.
