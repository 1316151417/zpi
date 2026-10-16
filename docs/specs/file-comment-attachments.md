# File comment attachments

File comments remain session-owned composer selections. A valid `file-comment:` source key is the discriminator; ordinary selected text, even when it has a file path or line-like text, stays a quotation. Existing saved drafts use the same discriminator and remain readable.

The composer and sent user message display comments in one separate count pill, preserving insertion order across files. The pill uses a message icon and “N 条评论”. Hover details show a code icon, basename and `L6` / `L6-L9`, a single-line ellipsized source path, and the user's comment (two lines); selected code remains in the model prompt but is not substituted for the comment. Each detail can navigate to its original line range. Removing one/all comments preserves ordinary quotations and other sessions, and updates the existing draft owner so preview markers disappear as before.

The existing userselect envelope retains complete text/path and validated comment identity/source metadata for newly sent comments. Ordinary quotation wire format is unchanged. Historical messages which already discarded metadata cannot reliably distinguish comments from ordinary quotations; preserve their content rather than guessing.

Acceptance: mixed comments/quotes, multiple files and ranges, empty comments, malformed discriminator, old saved draft, prompt round-trip, item/group removal, main/side-chat isolation, sent-message display, keyboard navigation and source-range navigation. Node helper/static-render tests may run without Electron; actual hover/desktop interaction requires a separate real desktop run.

## Keyboard interaction

Comment chips use an interactive Radix Popover, while ordinary quotation chips keep their existing HoverCard. Hover opens without stealing or restoring focus; a short cancellable leave delay bridges the pointer gap. Enter, Space or click explicitly opens and focuses the first action. Native Tab reaches source and delete controls, and Escape returns to the chip. Deleting an item closes the popover; deleting the final comment returns focus to the owning composer. Handler tests cover opening sources and dismissal; desktop keyboard assertions are collected but require a working GUI runtime to execute.
