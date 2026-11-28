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
import { Transcript } from "../src/tui/transcript.ts";

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

it("renders tool summaries and native write patches, preserves a single row through streaming updates", () => {
  const transcript = new Transcript();
  const render = () => stripVTControlCharacters(transcript.render(80).join("\n"));
  const args = { path: "README.md", content: "file content" };
  transcript.event({
    type: "tool_execution_start",
    toolCallId: "w",
    toolName: "write",
    args,
  });
  args.path = "changed after dispatch";
  transcript.event({
    type: "tool_execution_end",
    toolCallId: "w",
    toolName: "write",
    isError: false,
    result: {
      content: [{ type: "text", text: "写入完成" }],
      details: { fileChange: { patch: "+一行改动\n+一行解释" } },
    },
  });
  expect(render()).toContain("write README.md");
  expect(render()).toContain("写入完成");
  expect(render()).not.toContain("一行改动");
  transcript.toggleDetails();
  expect(render()).toContain("+一行改动");
  expect(render().match(/README\.md/g)).toHaveLength(1);
  transcript.toggleDetails();
  expect(render()).not.toContain("一行解释");
  transcript.reset([]);
  expect(render()).toBe("");
});

it("keeps tool previews valid Unicode when the cutoff falls inside an emoji", () => {
  const transcript = new Transcript();
  const prefix = "x".repeat(99);
  const full = `${prefix}🌱 done`;
  transcript.event({
    type: "tool_execution_end",
    toolCallId: "one",
    toolName: "read",
    isError: false,
    result: { content: [{ type: "text", text: full }], details: undefined },
  });
  const screen = () => stripVTControlCharacters(transcript.render(140).join("\n")).trimEnd();
  expect(screen().endsWith(prefix)).toBe(true);
  transcript.toggleDetails();
  expect(screen()).toContain(full);
});

it("separates speakers and expands only visible reasoning, including after replay", () => {
  const transcript = new Transcript();
  const user = { role: "user" as const, content: "你好", timestamp: 1 };
  const message = emptyAssistant(fakeModel(""));
  message.content = [
    { type: "thinking", thinking: "可见摘要", thinkingSignature: "signature-only" },
    { type: "thinking", thinking: "opaque-payload", redacted: true },
  ];
  const render = () => stripVTControlCharacters(transcript.render(32).join("\n"));
  transcript.user(user.content);
  transcript.event({ type: "message_start", message });
  transcript.event({
    type: "message_update",
    message,
    assistantMessageEvent: { type: "thinking_start", contentIndex: 0, partial: message },
  });
  expect(render()).toContain("思考中");
  expect(render()).not.toContain("可见摘要");
  message.content.push({ type: "text", text: "你好！" });
  transcript.event({ type: "message_end", message });
  expect(render()).toMatch(/❯ 你好[\s\S]+已思考 \d+ 秒[\s\S]+● 你好！/u);
  transcript.toggleDetails();
  expect(render()).toContain("可见摘要");
  expect(render()).not.toMatch(/opaque-payload|signature-only/);
  transcript.reset([user, message]);
  expect(render()).toContain("可见摘要");
  expect(render()).not.toMatch(/已思考 \d+ 秒|opaque-payload|signature-only/);
  transcript.toggleDetails();
  expect(render()).not.toContain("可见摘要");
});

it("wraps both speakers at the text column and keeps the full-width prompt readable without color", () => {
  const transcript = new Transcript();
  const assistant = emptyAssistant(fakeModel(""));
  assistant.content = [{ type: "text", text: "一二三四五六七八" }];
  transcript.reset([{ role: "user", timestamp: 1, content: "一二三四五六七八" }, assistant]);
  vi.stubEnv("NO_COLOR", undefined);
  try {
    const raw = transcript.render(10);
    const band = raw.filter((line) => line.includes("\x1b[48;5;"));
    expect(band.length).toBeGreaterThan(1);
    expect(band.every((line) => visibleWidth(line) === 10)).toBe(true);
    const plain = raw.map(stripVTControlCharacters);
    expect(plain.some((line) => line.startsWith("❯ 一二三四"))).toBe(true);
    expect(plain.some((line) => line.startsWith("● 一二三四"))).toBe(true);
    expect(plain.filter((line) => line.startsWith("  五六七八"))).toHaveLength(2);
    vi.stubEnv("NO_COLOR", "1");
    expect(transcript.render(10).join("")).not.toContain("\x1b[48;");
    expect(transcript.render(10).map(stripVTControlCharacters)).toEqual(plain);
  } finally {
    vi.unstubAllEnvs();
  }
});

it("renders mixed-phase answers once and keeps the Markdown cache on non-text updates", () => {
  const transcript = new Transcript();
  const message = emptyAssistant(fakeModel(""));
  message.content = [
    { type: "text", phase: "commentary", text: "Looking up. " },
    { type: "text", phase: "final_answer", text: "Done." },
  ];
  const render = () => stripVTControlCharacters(transcript.render(80).join("\n"));
  transcript.event({ type: "message_start", message });
  transcript.event({
    type: "message_update",
    message,
    assistantMessageEvent: { type: "text_delta", contentIndex: 1, partial: message, delta: "Done." },
  });
  const update = vi.spyOn(Markdown.prototype, "setText");
  try {
    transcript.event({
      type: "message_update",
      message,
      assistantMessageEvent: { type: "thinking_delta", contentIndex: 2, partial: message, delta: "reason" },
    });
    transcript.event({ type: "message_end", message });
    transcript.finishTurn("Done.");
    expect(update).not.toHaveBeenCalled();
    expect(render()).toContain("Looking up.");
    expect(render().match(/Done\./g)).toHaveLength(1);
    transcript.reset([message]);
    expect(render().match(/Done\./g)).toHaveLength(1);
  } finally {
    update.mockRestore();
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
  expect(screen()).not.toMatch(/正在编译|缺少依赖/);

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
  expect(live.render(60).join("\n")).not.toContain("\u001b[31m");
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
