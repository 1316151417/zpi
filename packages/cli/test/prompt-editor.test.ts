import { setImmediate } from "node:timers/promises";
import {
  CURSOR_MARKER,
  Editor,
  ProcessTerminal,
  stripTerminalSequences,
  TuiMainScreen,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Completions, withArgumentChoices } from "../src/tui/completion.ts";
import { PromptEditor } from "../src/tui/prompt-editor.ts";
import { listTheme, suggestion, thinkingBorderColor } from "../src/tui/theme.ts";

const commands = [
  { name: "校对", kind: "skill" as const },
  { name: "校对中文说明", kind: "skill" as const },
  { name: "$help", kind: "skill" as const },
  { name: "rename", argumentHint: "<新名称>" },
  { name: "multiline", argumentHint: "<源文件>\n<目标文件>" },
  { name: "model", argumentHint: "[提供商/模型]" },
  { name: "fast", argumentHint: "[on|off]" },
];
let highlight: string;
beforeEach(() => {
  vi.stubEnv("NO_COLOR", undefined);
  highlight = suggestion("/").split("/")[0];
});
afterEach(() => vi.unstubAllEnvs());
function fixture(isLiteral = (_: string) => false) {
  const tui = new TuiMainScreen(new ProcessTerminal());
  vi.spyOn(tui, "requestRender").mockImplementation(() => {});
  const completions = new Completions(".", () =>
    withArgumentChoices(commands, {
      model: () => ["team/coder", "team/org/writer"],
      fast: () => ["on", "off"],
    }),
  );
  const editor = new PromptEditor(tui, completions, isLiteral);
  editor.focused = true;
  return { tui, editor, completions };
}

it("matches Pi's native cursor, wrapping and horizontal borders on ordinary input", () => {
  const { tui, editor } = fixture();
  const native = new Editor(tui, { borderColor: thinkingBorderColor(), selectList: listTheme });
  native.focused = true;
  for (const text of ["", "中文输入 hello", "第一行\n第二行"]) {
    native.setText(text);
    editor.setText(text);
    for (const width of [7, 20]) expect(editor.render(width)).toEqual(native.render(width));
  }
  expect(editor.getPaddingX()).toBe(0);
  editor.borderColor = thinkingBorderColor("high");
  expect(editor.render(20)[0]).toBe(thinkingBorderColor("high")("─".repeat(20)));
  expect(editor.render(20)[0]).not.toBe(native.render(20)[0]);
});

it("shows a partial Skill in the menu and the complete Skill on the actual input line", async () => {
  const { editor } = fixture();
  editor.handleInput("/");
  await setImmediate();
  editor.handleInput("校");
  await setImmediate();
  expect(editor.isShowingAutocomplete()).toBe(true);
  expect(editor.render(44)[1]).not.toContain(highlight);
  editor.handleInput("对");
  await setImmediate();
  expect(editor.isShowingAutocomplete()).toBe(false);
  expect(editor.render(44)[1]).toContain(`${highlight}/校对`);
  editor.handleInput("\t");
  expect(editor.getText()).toBe("/校对 ");
  editor.handleInput("中文示例");
  expect(stripTerminalSequences(editor.render(44)[1]).trim()).toBe("/校对 中文示例");
  const submit = vi.fn();
  editor.onSubmit = submit;
  editor.handleInput("\r");
  expect(submit).toHaveBeenCalledExactlyOnceWith("/校对 中文示例");
});

it("keeps a programmatically selected Skill colored when wrapped, edited or followed by a new line", async () => {
  const { editor } = fixture();
  editor.setText("/校对中文说明\n第二行");
  await setImmediate();
  const rows = editor.render(10);
  const colored = rows.filter((row) => row.includes(highlight));
  expect(colored.length).toBeGreaterThan(1);
  expect(colored.map((row) => stripTerminalSequences(row).trim()).join("")).toBe("/校对中文说明");
  expect(rows.filter((row) => row.includes(CURSOR_MARKER))).toHaveLength(1);
  expect(rows.every((row) => visibleWidth(row) <= 10)).toBe(true);
  editor.setText("/$help 参数");
  await setImmediate();
  expect(editor.render(44)[1]).toContain(suggestion("/$help"));
  editor.setText("/not-a-skill");
  await setImmediate();
  expect(editor.render(44)[1]).not.toContain(highlight);
});

it("preserves the hardware cursor inside a colored Skill and keeps a pasted slash literal", async () => {
  const { editor } = fixture((name) => name === "/$help");
  editor.setText("/校对 中文");
  await setImmediate();
  editor.handleInput("\x01"); // home
  editor.handleInput("\x1b[C");
  expect(editor.getCursor()).toEqual({ line: 0, col: 1 });
  const row = editor.render(30)[1];
  expect(row.indexOf(CURSOR_MARKER)).toBeGreaterThan(row.indexOf(highlight));
  expect(stripTerminalSequences(row).trim()).toBe("/校对 中文");
  editor.setText("");
  editor.handleInput("\x1b[200~/$help 例子\x1b[201~");
  await setImmediate();
  expect(editor.render(30)[1]).not.toContain(highlight);
  expect(editor.getExpandedText()).toBe("/$help 例子");
});

it("previews argument usage in suggestions and shows an editable-input hint only before an argument", async () => {
  const { editor, completions } = fixture();
  const list = await completions.getSuggestions(["/ren"], 0, 4, { signal: new AbortController().signal });
  expect(list?.items.map((item) => item.label)).toEqual(["/rename <新名称>"]);
  editor.setText("/rename ");
  await setImmediate();
  expect(stripTerminalSequences(editor.render(40)[1])).toContain("<新名称>");
  expect(visibleWidth(editor.render(13)[1])).toBe(13);
  expect(editor.getExpandedText()).toBe("/rename ");
  editor.handleInput("工作");
  expect(stripTerminalSequences(editor.render(40)[1])).not.toContain("<新名称>");
  const submit = vi.fn();
  editor.onSubmit = submit;
  editor.handleInput("\r");
  expect(submit).toHaveBeenCalledExactlyOnceWith("/rename 工作");
  editor.setText("/multiline ");
  await setImmediate();
  expect(stripTerminalSequences(editor.render(45)[1])).toContain("<源文件> <目标文件>");
});

it("does not replace the text just typed when Enter arrives before an older menu refresh", async () => {
  const { editor } = fixture();
  editor.handleInput("/");
  await setImmediate();
  editor.handleInput("校对中文说明");
  const submit = vi.fn();
  editor.onSubmit = submit;
  editor.handleInput("\r");
  expect(submit).toHaveBeenCalledExactlyOnceWith("/校对中文说明");
});

it("uses Tab to fill the chosen provider/model and Enter to submit the current model search", async () => {
  const { editor } = fixture();
  const submit = vi.fn();
  editor.onSubmit = submit;
  editor.handleInput("/model writer");
  await setImmediate();
  expect(editor.isShowingAutocomplete()).toBe(true);
  expect(editor.render(60).map(stripTerminalSequences).join("\n")).toContain("team/org/writer");
  editor.handleInput("\r");
  expect(submit).toHaveBeenLastCalledWith("/model writer");

  editor.handleInput("/model team/org");
  await setImmediate();
  editor.handleInput("\t");
  expect(editor.getExpandedText()).toBe("/model team/org/writer");
  editor.handleInput("\r");
  expect(submit).toHaveBeenLastCalledWith("/model team/org/writer");
});

it("completes scalar arguments at the cursor and leaves Skill arguments as free text", async () => {
  const { completions } = fixture();
  const options = { signal: new AbortController().signal };
  const input = "/fast o";
  const choices = await completions.getSuggestions([input], 0, input.length, options);
  expect(choices?.items.map((item) => item.value)).toEqual(["on", "off"]);
  if (!choices) throw new Error("Missing fast choices");
  const off = choices.items[1];
  expect(completions.applyCompletion(["/fast on"], 0, input.length, off, choices.prefix).lines).toEqual([
    "/fast off",
  ]);
  expect(completions.applyCompletion(["/校对 o"], 0, 5, off, choices.prefix).lines).toEqual(["/校对 o"]);
  expect(await completions.getSuggestions(["/校对 writer"], 0, 10, options)).toBeNull();
});
