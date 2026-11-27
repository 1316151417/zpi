import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { Markdown } from "@earendil-works/pi-tui";
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
