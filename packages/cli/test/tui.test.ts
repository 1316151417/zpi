import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { Markdown, visibleWidth } from "@earendil-works/pi-tui";
import { emptyAssistant } from "@zpi-dev/ai";
import { expect, it, vi } from "vitest";
import { fakeModel } from "../../../tests/fake-server.ts";
import { commands } from "../src/host/commands.ts";
import { Completions, references } from "../src/tui/completion.ts";
import { SearchPicker } from "../src/tui/search-picker.ts";
import { Transcript } from "../src/tui/transcript.ts";

it("keeps the current model tick while navigating Pi's filtered list and saves the highlighted model", () => {
  const choose = vi.fn();
  const cancel = vi.fn();
  const picker = new SearchPicker(
    [
      { value: "team/org/writer", label: "Writer" },
      { value: "team/coder", label: "公司模型" },
    ],
    "",
    "team/org/writer",
    choose,
    cancel,
    { defaultModel: "team/coder" },
  );
  const screen = () => picker.render(74).map(stripVTControlCharacters);
  expect(screen()[0]).toBe("─".repeat(74));
  expect(screen().at(-1)).toBe("─".repeat(74));
  expect(screen().join("\n")).toContain("→ ✓ org/writer [team]");
  expect(screen().join("\n")).toContain("coder (公司模型) [team] · default");
  picker.handleInput("\x1b[B");
  picker.handleInput("\x1b[D");
  expect(screen().join("\n")).toContain("→   coder (公司模型)");
  expect(screen().join("\n")).toContain("模型名称：公司模型");
  expect(screen().join("\n")).toContain("  ✓ org/writer");
  picker.handleInput("d");
  picker.handleInput("\x13");
  expect(choose).toHaveBeenCalledWith("team/coder", true);
  picker.handleInput("zzzz");
  expect(screen().join("\n")).toContain("没有匹配的模型");
  picker.handleInput("\x1b");
  expect(cancel).toHaveBeenCalledOnce();
});

it("completes only a command name at the prompt and accepts explicit workspace files and directories", async () => {
  const temp = await realpath(await mkdtemp(join(tmpdir(), "zpi-cli-complete-")));
  try {
    const cwd = join(temp, "project");
    await mkdir(cwd);
    await mkdir(join(cwd, "docs"));
    await writeFile(join(cwd, "docs", "设计 图.png"), "");
    await symlink(temp, join(cwd, "outside"));
    const provider = new Completions(cwd, () => commands);
    const options = { signal: new AbortController().signal };
    const complete = (line: string) => provider.getSuggestions([line], 0, line.length, options);
    const command = await complete("/mo");
    expect(command?.items.map((item) => item.value)).toEqual(["model"]);
    expect(await complete("/review")).toBeNull();
    expect(await provider.getSuggestions(["代码", "/mo"], 1, 3, options)).toBeNull();
    expect(await complete("@../")).toBeNull();
    expect(await complete("@outside/")).toBeNull();

    const line = '请看 @"docs/设';
    const item = await complete(line);
    expect(item?.items[0].value).toBe("docs/设计 图.png");
    if (!item) throw new Error("file completion missing");
    const result = provider.applyCompletion([`${line}尾部`], 0, line.length, item.items[0], item.prefix);
    expect(result.lines[0].slice(result.cursorCol)).toBe("尾部");
    expect(references(result.lines[0])).toEqual(["./docs/设计 图.png"]);
    expect(references(`\`${result.lines[0]}\``)).toEqual([]);
    const folder = await complete("@doc");
    if (!folder) throw new Error("directory completion missing");
    const selected = provider.applyCompletion(["@doc"], 0, 4, folder.items[0], folder.prefix);
    expect(references(selected.lines[0])).toEqual(["./docs/"]);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

it.each([
  ["/compact 保留测试结论", "/compact 保留测试结论"],
  ["/comproject notes", "/compact project notes"],
])(
  "completes a slash command at the cursor without losing or duplicating text: %s",
  async (line, expected) => {
    const provider = new Completions(".", () => commands);
    const options = { signal: new AbortController().signal };
    const cursor = "/com".length;
    const suggestions = await provider.getSuggestions([line], 0, cursor, options);
    expect(suggestions?.items.map((item) => item.value)).toEqual(["compact"]);
    if (!suggestions) throw new Error("Missing compact suggestion");
    const completed = provider.applyCompletion([line], 0, cursor, suggestions.items[0], suggestions.prefix);
    expect(completed.lines).toEqual([expected]);
    expect(completed.cursorCol).toBe("/compact ".length);
    expect(await provider.getSuggestions([line], 0, line.length, options)).toBeNull();
  },
);

it("shares a command scan while typing and refreshes after accepting a choice or pausing", async () => {
  let name = "model";
  const list = vi.fn(() => [{ name }]);
  const provider = new Completions(".", list);
  const complete = (line: string) =>
    provider.getSuggestions([line], 0, line.length, { signal: new AbortController().signal });
  const clock = vi.spyOn(Date, "now").mockReturnValue(0);
  try {
    await complete("/");
    const matches = await complete("/mo");
    expect(list).toHaveBeenCalledTimes(1);
    expect(matches?.items[0]?.value).toBe("model");
    if (!matches) throw new Error("Missing command");
    provider.applyCompletion(["/mo"], 0, 3, matches.items[0], matches.prefix);
    expect((await provider.findCommand("model"))?.name).toBe("model");
    expect(list).toHaveBeenCalledTimes(1);
    name = "more";
    expect((await complete("/mo"))?.items[0]?.value).toBe("more");
    name = "modified";
    clock.mockReturnValue(2000);
    expect((await complete("/mod"))?.items[0]?.value).toBe("modified");
    expect(list).toHaveBeenCalledTimes(3);
  } finally {
    clock.mockRestore();
  }
});

it("handles server retry, context compaction and command-only results without reprinting prior answers", () => {
  const transcript = new Transcript();
  transcript.event({
    type: "model_retry",
    status: { attempt: 1, maxRetries: 3, retryDelayMs: 500, errorStatus: 429 },
  });
  transcript.event({ type: "compaction", id: "compact", status: "running", origin: "manual" });
  transcript.event({ type: "command_result", message: "已压缩" });
  transcript.finishTurn("已压缩");
  const output = transcript.render(40).join("\n");
  expect(output.match(/已压缩/g)).toHaveLength(1);
  expect(output).toContain("模型重试 1/3");
  expect(output).toContain("正在压缩");
  transcript.beginTurn();
  transcript.finishTurn("当前会话尚无上下文");
  expect(transcript.render(40).join("\n")).toContain("当前会话尚无上下文");
});

it("replaces a running tool's output and renders its completed row exactly as in history", () => {
  const live = new Transcript();
  const call = { toolCallId: "build-1", toolName: "bash", args: { command: "make" } };
  const result = (text: string) => ({ content: [{ type: "text" as const, text }], details: undefined });
  const screen = () => stripVTControlCharacters(live.render(60).join("\n"));
  live.event({ type: "tool_execution_start", ...call });
  live.event({ type: "tool_execution_update", ...call, partialResult: result("正在编译") });
  expect(screen()).toContain("正在编译");

  const output = result("编译结束\r\n\u001b[31m缺少依赖\u001b[0m");
  live.event({ type: "tool_execution_end", ...call, result: output, isError: true });
  expect(screen()).toContain("失败");
  expect(screen()).toContain("编译结束");
  expect(screen()).not.toContain("正在编译");
  expect(screen()).toContain("缺少依赖");

  const message = emptyAssistant(fakeModel(""));
  message.content = [{ type: "toolCall", id: call.toolCallId, name: call.toolName, arguments: call.args }];
  const history = new Transcript();
  history.reset([
    message,
    {
      role: "toolResult",
      ...output,
      toolCallId: call.toolCallId,
      toolName: call.toolName,
      isError: true,
      timestamp: 1,
    },
  ]);
  expect(live.render(60)).toEqual(history.render(60));
  live.toggleDetails();
  history.toggleDetails();
  expect(screen()).toContain("缺少依赖");
  expect(live.render(60).join("\n")).not.toContain("\u001b[31m缺少依赖");
  expect(live.render(60)).toEqual(history.render(60));
});

it("renders chunked Markdown like a single replayed message at narrow and wide widths", () => {
  const live = new Transcript();
  const history = new Transcript();
  const message = emptyAssistant(fakeModel(""));
  live.event({ type: "message_start", message });
  let text = "";
  for (const delta of [
    "## 构建结果\n\n正在**检",
    "查**终端换行和分段渲染。\n\n```sh\n",
    "make test\n",
    "```\n\n完成",
  ]) {
    text += delta;
    message.content = [{ type: "text", text }];
    live.event({
      type: "message_update",
      message,
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, partial: message, delta },
    });
    history.reset([message]);
    expect(live.render(20)).toEqual(history.render(20));
  }
  live.event({ type: "message_end", message });
  live.finishTurn(text);
  const narrow = live.render(20);
  const wide = live.render(80);
  expect(narrow.length).toBeGreaterThan(wide.length);
  expect(wide).toEqual(history.render(80));
  const visible = stripVTControlCharacters(wide.join("\n"));
  expect(visible).toContain("检查终端换行和分段渲染");
  expect(visible).toContain("make test");
  expect(visible.match(/完成/g)).toHaveLength(1);
});

function screen(ui: Transcript, width = 60) {
  return ui.render(width).map((line) => stripVTControlCharacters(line).trimEnd());
}

it("streams provider-visible thinking as Pi Markdown, independently of tool expansion, and replays it", () => {
  const ui = new Transcript();
  const message = emptyAssistant(fakeModel(""));
  const thought = { type: "thinking" as const, thinking: "", thinkingSignature: "secret signature" };
  message.content = [thought];
  ui.event({ type: "message_start", message });
  ui.event({
    type: "message_update",
    message,
    assistantMessageEvent: { type: "thinking_start", contentIndex: 0, partial: message },
  });
  expect(screen(ui)).toEqual([]);
  thought.thinking = "检查 **配置**";
  ui.event({
    type: "message_update",
    message,
    assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "配置", partial: message },
  });
  expect(screen(ui)).toContain(" 检查 配置");
  message.content.push(
    { type: "thinking", thinking: "second thought" },
    { type: "thinking", thinking: "opaque payload", redacted: true },
    { type: "text", text: "Done." },
  );
  ui.event({ type: "message_end", message });
  const initial = screen(ui);
  expect(initial).toContain(" second thought");
  expect(initial).toContain(" Done.");
  expect(initial.join(" ")).not.toMatch(/secret signature|opaque payload|未返回/);
  ui.toggleDetails();
  expect(screen(ui)).toEqual(initial);
  expect(ui.toggleThinking()).toBe(true);
  expect(screen(ui).filter((line) => line === " 思考…")).toHaveLength(1);
  expect(screen(ui)).not.toContain(" second thought");
  ui.reset([message]);
  expect(screen(ui)).not.toContain(" 检查 配置");
  expect(ui.toggleThinking()).toBe(false);
  expect(screen(ui)).toEqual(initial);
  const hidden = new Transcript(true);
  hidden.reset([message]);
  expect(screen(hidden)).toContain(" 思考…");
});

it("omits empty, redacted and token-only reasoning without disclosing signatures or placeholder lines", () => {
  const ui = new Transcript();
  const message = emptyAssistant(fakeModel(""));
  message.content = [
    { type: "thinking", thinking: "opaque token body", redacted: true },
    { type: "text", text: "answer" },
  ];
  ui.reset([message]);
  expect(screen(ui)).toEqual([" answer"]);
  message.content.shift();
  message.usage.reasoning = 5;
  ui.reset([message]);
  expect(screen(ui)).toEqual([" answer"]);
  message.usage.reasoning = 0;
  ui.reset([message]);
  expect(screen(ui)).toEqual([" answer"]);
});

it("uses the native Pi user band, thinking style, spacing, Markdown headings, fences and list rows", () => {
  vi.stubEnv("NO_COLOR", undefined);
  try {
    const ui = new Transcript();
    const message = emptyAssistant(fakeModel(""));
    message.content = [
      { type: "thinking", thinking: "Reason one" },
      { type: "toolCall", id: "r", name: "read", arguments: { path: "demo.txt" } },
      {
        type: "text",
        text: "### Heading\n\nSecond paragraph:\n- line one\n- line two\n\n```ts\nconst ok = true;\n```\n\nFinal line.",
      },
    ];
    ui.reset([
      { role: "user", content: "demonstrate", timestamp: 1 },
      message,
      {
        role: "toolResult",
        toolCallId: "r",
        toolName: "read",
        content: [{ type: "text", text: "第一行\n第二行" }],
        isError: false,
        timestamp: 1,
      },
    ]);
    const raw = ui.render(62);
    expect(
      raw.slice(0, 3).every((line) => line.includes("\x1b[48;2;33;44;79m") && visibleWidth(line) === 62),
    ).toBe(true);
    const thought = raw.find((line) => line.includes("Reason one"));
    expect(thought).toContain("\x1b[3m");
    expect(thought).toContain("\x1b[38;2;151;151;151m");
    const code = raw.find((line) => line.includes("const"));
    expect(code).toContain("\x1b[38;2;120;153;249mconst\x1b[39m");
    expect(code).toContain("\x1b[38;2;111;178;105mtrue\x1b[39m");
    expect(screen(ui)).toEqual([
      "",
      " demonstrate",
      "",
      "",
      " Reason one",
      "",
      "",
      " read demo.txt",
      "",
      "",
      " ### Heading",
      "",
      " Second paragraph:",
      " - line one",
      " - line two",
      "",
      " ```ts",
      "   const ok = true;",
      " ```",
      "",
      " Final line.",
    ]);
    ui.toggleDetails();
    expect(screen(ui)).toContain(" 第一行");
    expect(screen(ui)).toContain(" 第二行");
    expect(screen(ui)).toContain(" Reason one");
    ui.toggleThinking();
    expect(screen(ui)).toContain(" 思考…");
    expect(screen(ui)).toContain(" 第一行");
    expect(ui.render(12).every((line) => visibleWidth(line) <= 12)).toBe(true);
  } finally {
    vi.unstubAllEnvs();
  }
});

it("previews the last five visual Bash output lines and expands the full, sanitized original", () => {
  const ui = new Transcript();
  const call = { toolCallId: "1", toolName: "bash", args: { command: "make" } };
  ui.event({ type: "tool_execution_start", ...call });
  ui.event({
    type: "tool_execution_end",
    ...call,
    isError: false,
    result: { content: [{ type: "text", text: "一🌱\n二\n三\n四\n五\n六\n七" }], details: undefined },
  });
  expect(screen(ui)).toEqual([
    "",
    " $ make",
    "",
    " … 前面 2 行（Ctrl+O 展开）",
    " 三",
    " 四",
    " 五",
    " 六",
    " 七",
    "",
  ]);
  ui.toggleDetails();
  expect(screen(ui)).toEqual(["", " $ make", "", " 一🌱", " 二", " 三", " 四", " 五", " 六", " 七", ""]);
});

it("shows Write input and Edit diff on the default screen while keeping native mutation details available", () => {
  const ui = new Transcript();
  const write = {
    toolName: "write",
    toolCallId: "w",
    args: { path: "README.md", content: Array.from({ length: 11 }, (_, i) => `line ${i + 1}`).join("\n") },
  };
  ui.event({ type: "tool_execution_start", ...write });
  write.args.path = "changed after dispatch";
  ui.event({
    type: "tool_execution_end",
    toolName: "write",
    toolCallId: "w",
    isError: false,
    result: {
      content: [{ type: "text", text: "写入完成" }],
      details: { fileChange: { patch: "+一行改动" } },
    },
  });
  expect(screen(ui)).toContain(" write README.md");
  expect(screen(ui)).toContain(" line 10");
  expect(screen(ui)).not.toContain(" line 11");
  ui.toggleDetails();
  expect(screen(ui)).toContain(" line 11");
  expect(screen(ui)).toContain(" +一行改动");
  ui.toggleDetails();
  const edit = { toolName: "edit", toolCallId: "e", args: { path: "src.ts" } };
  ui.event({ type: "tool_execution_start", ...edit });
  ui.event({
    type: "tool_execution_end",
    ...edit,
    isError: false,
    result: { content: [], details: { diff: "-1 old\n+1 new" } },
  });
  expect(screen(ui).slice(-6)).toEqual(["", " edit src.ts", "", " -1 old", " +1 new", ""]);
});

it("distinguishes plain-terminal user, thinking, error and info rows and limits all lines to the terminal width", () => {
  vi.stubEnv("NO_COLOR", "1");
  try {
    const ui = new Transcript();
    const message = emptyAssistant(fakeModel(""));
    message.content = [
      { type: "thinking", thinking: "思考正文" },
      { type: "text", text: "一二三四五六七八" },
    ];
    ui.reset([{ role: "user", content: "一二三四五六七八", timestamp: 1 }, message]);
    ui.note("已中断");
    ui.note("请先登录", "error");
    expect(screen(ui)).toContain(" 你");
    expect(screen(ui)).toContain(" 思考");
    expect(screen(ui)).toContain(" ℹ  已中断");
    expect(screen(ui)).toContain(" ✕  请先登录");
    expect(ui.render(10).every((line) => visibleWidth(line) <= 10)).toBe(true);
    expect(ui.render(10).join("")).not.toContain("\x1b[");
  } finally {
    vi.unstubAllEnvs();
  }
});

it("preserves mixed-phase answers across unrelated updates and removes provisional blocks on stream reset", () => {
  const ui = new Transcript();
  const message = emptyAssistant(fakeModel(""));
  message.content = [
    { type: "text", text: "Looking up.", phase: "commentary" },
    { type: "text", text: "Done.", phase: "final_answer" },
  ];
  ui.event({ type: "message_end", message });
  expect(screen(ui)).toEqual([" Looking up.", " Done."]);
  const setText = vi.spyOn(Markdown.prototype, "setText");
  try {
    ui.event({ type: "message_end", message });
    ui.finishTurn("Done.");
    expect(setText).not.toHaveBeenCalled();
    expect(screen(ui)).toEqual([" Looking up.", " Done."]);
    message.content = [
      { type: "thinking", thinking: "old thoughts" },
      { type: "toolCall", id: "old", name: "bash", arguments: { command: "old command" } },
    ];
    ui.event({ type: "message_end", message });
    message.content = [{ type: "text", text: "restarted" }];
    ui.event({ type: "message_update", message, assistantMessageEvent: { type: "reset", partial: message } });
    expect(screen(ui)).toEqual([" restarted"]);
  } finally {
    setText.mockRestore();
  }
});
