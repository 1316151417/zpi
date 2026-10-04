export interface EditorState {
  text: string;
  selection: [number, number];
}
/** Canonical Markdown, rather than DOM mutations, is the unit of undo. */
export class EditorHistory {
  past: EditorState[] = [];
  future: EditorState[] = [];
  record(before: EditorState, after: string): void {
    if (before.text === after) return;
    this.past.push({ text: before.text, selection: [...before.selection] });
    while (
      this.past.length > 1 &&
      (this.past.length > 100 ||
        this.past.reduce((n, state) => n + state.text.length * 2, 0) > 2 * 1024 * 1024)
    )
      this.past.shift();
    this.future = [];
  }
  undo(current: EditorState): EditorState | undefined {
    const previous = this.past.pop();
    if (previous) this.future.push(current);
    return previous;
  }
  redo(current: EditorState): EditorState | undefined {
    const next = this.future.pop();
    if (next) this.past.push(current);
    return next;
  }
  clear(): void {
    this.past = [];
    this.future = [];
  }
}
