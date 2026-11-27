import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { expect, it } from "vitest";
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

it("renders tool summaries and native write patches, preserves a single row through streaming updates", () => {
  const transcript = new Transcript();
  const render = () => stripVTControlCharacters(transcript.render(80).join("\n"));
  transcript.event({
    type: "tool_execution_start",
    toolCallId: "w",
    toolName: "write",
    args: { path: "README.md" },
  });
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

it("handles server retry, context compaction and command-only results without reprinting prior answers", () => {
  const transcript = new Transcript();
  transcript.event({
    type: "model_retry",
    status: { attempt: 1, maxRetries: 3, retryDelayMs: 500, errorStatus: 429 },
  });
  transcript.event({ type: "compaction", id: "compact", status: "running", origin: "manual" });
  transcript.event({ type: "command_result", message: "已压缩" });
  expect(transcript.lastAnswer).toBe("已压缩");
  const output = transcript.render(40).join("\n");
  expect(output).toContain("模型重试 1/3");
  expect(output).toContain("正在压缩");
  transcript.beginTurn();
  expect(transcript.lastAnswer).toBe("");
});
