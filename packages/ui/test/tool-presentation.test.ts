import { expect, it } from "vitest";
import {
  executionCommand,
  groupSummary,
  patchPreviewLines,
  processItems,
  type ToolGroupView,
  type ToolView,
  toolFile,
  toolGroupKind,
} from "../src/components/tool-presentation.ts";
import type { ViewBlock } from "../src/types.ts";

const tool = (id: string, name = "read", args: Record<string, unknown> = { path: "src/a.ts" }): ToolView => ({
  id,
  messageId: "message",
  type: "tool",
  toolCallId: id,
  name,
  argsText: JSON.stringify(args),
  status: "completed",
  output: "",
});
const thought = (text: string): ViewBlock => ({ id: text, messageId: "message", type: "thinking", text });

it.each([
  ["/bin/zsh -lc 'rg foo src && ls src'", "explore"],
  ['pwsh -NoProfile -Command "Get-Content src/a.ts"', "explore"],
  ["git status && git diff", "explore"],
  ["sed -n '1,10p' src/a.ts", "explore"],
  ["ls src > result.txt", "execute"],
  ["rg foo src && rm src/a.ts", "execute"],
  ["git diff; git checkout -- src/a.ts", "execute"],
  ["npm test", "execute"],
])("matches ZCode's exploration classification: %s", (command, kind) => {
  expect(toolGroupKind(tool("bash", "bash", { command }))).toBe(kind);
});

it("groups the second adjacent tool and preserves identity as children arrive", () => {
  const a = tool("a"),
    b = tool("b"),
    c = tool("c");
  expect(processItems([a], true)).toEqual([{ kind: "block", id: a.id, block: a }]);
  expect(processItems([a, thought(" \n"), b], true)).toEqual([
    { kind: "explore", id: "explore:a", children: [a, b], running: true },
  ]);
  expect(processItems([a, b, c], false)).toEqual([
    { kind: "explore", id: "explore:a", children: [a, b, c], running: false },
  ]);
});

it("ends groups at visible work boundaries, even before late child results arrive", () => {
  const a = tool("a"),
    b = { ...tool("b"), status: "running" as const };
  const boundary = thought("下一步");
  const items = processItems([a, b, boundary, tool("edit", "edit"), tool("c")], true);
  expect(items[0]).toMatchObject({ id: "explore:a", running: false });
  expect(items.slice(1).map((item) => item.id)).toEqual([boundary.id, "edit", "c"]);
});

it("hides unfinished shell parameters without splitting adjacent exploration", () => {
  const pending = { ...tool("pending", "bash"), argsText: '{"command":', status: "preparing" as const };
  expect(processItems([tool("a"), pending, tool("b")], true)[0]).toMatchObject({
    kind: "explore",
    children: [tool("a"), tool("b")],
  });
  expect(toolGroupKind(tool("write", "write"))).toBeUndefined();
});

it("counts tool calls by bucket and terminal failures", () => {
  const group: ToolGroupView = {
    kind: "explore",
    id: "group",
    running: false,
    children: [
      tool("a"),
      tool("b", "bash", { command: "bash -lc 'ls src; rg foo src'" }),
      tool("c", "bash", { command: "find src" }),
    ],
  };
  expect(groupSummary(group)).toBe("1 搜索, 1 列表, 1 文件");
  expect(
    groupSummary({
      ...group,
      kind: "execute",
      children: [tool("a", "bash"), { ...tool("b", "bash"), status: "error" }],
    }),
  ).toBe("2 个命令, 1 个失败");
});

it("renders a leaf chip and workspace-relative directory, preserving the open destination", () => {
  expect(toolFile(tool("a", "read", { path: "/project/src/a.ts" }), "/project/")).toEqual({
    path: "/project/src/a.ts",
    name: "a.ts",
    directory: "src/",
  });
  expect(toolFile(tool("a", "read", { path: "C:\\project\\src\\a.ts" }), "C:\\project")).toMatchObject({
    directory: "src/",
  });
  expect(executionCommand("/bin/bash -lc 'printf hello'")).toBe("'printf hello'");
});

it("keeps actual patch content that looks like headers and displays metadata-only changes", () => {
  expect(patchPreviewLines("--- a/a.sql\n+++ b/a.sql\n@@ -1 +1 @@\n--- comment\n+++ comment\n\n")).toEqual([
    "--- comment",
    "+++ comment",
  ]);
  expect(patchPreviewLines("diff --git a/a b/a\nold mode 100644\nnew mode 100755\n")).toEqual([
    "old mode 100644",
    "new mode 100755",
  ]);
  expect(patchPreviewLines("@@\n")).toEqual([""]);
});

it("limits huge inline patches to ZCode's head, omitted count, and tail", () => {
  const patch = `@@\n${Array.from({ length: 1000 }, (_, i) => `+line${i}`).join("\n")}`;
  const lines = patchPreviewLines(patch);
  expect(lines).toHaveLength(800);
  expect(lines[0]).toBe("+line0");
  expect(lines[400]).toBe("\\ __ZCODE_DIFF_TRUNCATED__:201");
  expect(lines.at(-1)).toBe("+line999");
});
