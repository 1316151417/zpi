import {
  Editor,
  matchesKey,
  renderFakeCursor,
  type SlashCommand,
  stripTerminalSequences,
  type TUI,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { type Completions, submitsSlashArguments } from "./completion.ts";
import { dim, listTheme, safeText, suggestion, thinkingBorderColor } from "./theme.ts";

export class PromptEditor extends Editor {
  private token?: string;
  private command?: SlashCommand;
  private hiddenLines = 0;

  constructor(tui: TUI, completions: Completions, isLiteral: (token: string) => boolean) {
    super(tui, { borderColor: thinkingBorderColor(), selectList: listTheme });
    this.setAutocompleteProvider(completions);
    this.onChange = (text) => {
      const first = /^\/\S+/u.exec(text)?.[0];
      const token = first && !isLiteral(first) ? first : undefined;
      if (token === this.token) return;
      this.token = token;
      this.command = undefined;
      if (token) {
        void completions.findCommand(token.slice(1)).then((command) => {
          if (this.token === token) {
            this.command = command;
            tui.requestRender();
          }
        });
      }
    };
  }
  protected override renderTopBorder(width: number, hiddenLineCount: number) {
    this.hiddenLines = hiddenLineCount;
    return super.renderTopBorder(width, hiddenLineCount);
  }
  override handleInput(data: string) {
    if (matchesKey(data, "enter") && this.isShowingAutocomplete()) {
      const { line, col } = this.getCursor();
      // Tab fills a suggested argument; Enter runs what the user typed, including a model search.
      if (line === 0 && submitsSlashArguments(this.getLines()[0].slice(0, col))) super.handleInput("\x1b");
    }
    if (
      matchesKey(data, "tab") &&
      !this.isShowingAutocomplete() &&
      this.command &&
      this.getText() === this.token &&
      this.getCursor().col === this.token?.length
    ) {
      this.insertTextAtCursor(" ");
      return;
    }
    super.handleInput(data);
  }
  override render(width: number) {
    const lines = super.render(width);
    const padding = Math.min(this.getPaddingX(), Math.max(0, Math.floor((width - 1) / 2)));
    const token = this.token;
    if (token && this.command) {
      if (
        this.command.argumentHint &&
        this.getText() === `${token} ` &&
        this.getCursor().col === token.length + 1
      )
        this.showHint(lines, this.command.argumentHint, padding);
      // The command is a single, leading word. Color its visible wrapped rows inside the editor only.
      const layoutWidth = Math.max(1, width - padding * 2 - (padding ? 0 : 1));
      const chunks = wrapTextWithAnsi(token, layoutWidth);
      for (let i = 1; i <= chunks.length - this.hiddenLines && i < lines.length; i++) {
        const body = lines[i].slice(padding);
        if (!stripTerminalSequences(body).startsWith(chunks[this.hiddenLines + i - 1])) break;
        lines[i] = lines[i].slice(0, padding) + body.replace(/^\S+/u, suggestion);
      }
    }
    return lines;
  }
  private showHint(lines: string[], hint: string, padding: number) {
    // Keep the hardware/IME cursor markers intact and use only empty cells past the cursor.
    const cursor = renderFakeCursor(" ");
    const row = lines.findIndex((line) => line.includes(cursor));
    if (row < 0) return;
    const line = lines[row];
    const start = line.indexOf(cursor) + cursor.length;
    const room = line.length - start - padding;
    if (room < 1) return;
    const text = truncateToWidth(safeText(hint).replaceAll("\n", " "), room);
    lines[row] = line.slice(0, start) + dim(text) + line.slice(start + visibleWidth(text));
  }
}
