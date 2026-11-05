import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";
import { Markdown } from "../src/components/Markdown.tsx";
import { ToolFileChip, ToolFilePreview } from "../src/components/ToolBlock.tsx";
import type { ToolView } from "../src/components/tool-presentation.ts";

const links = vi.hoisted(() => [] as Array<{ onOpen?: () => void }>);
vi.mock("../src/components/Reference.tsx", async (original) => ({
  ...(await original<typeof import("../src/components/Reference.tsx")>()),
  Reference: (props: { onOpen?: () => void }) => {
    links.push(props);
    return null;
  },
}));
beforeEach(() => {
  links.length = 0;
});
const block: ToolView = {
  id: "tool",
  messageId: "message",
  type: "tool",
  toolCallId: "tool",
  name: "write",
  status: "completed",
  output: "",
  argsText: JSON.stringify({ path: "notes.md", content: "[page](./page.html)" }),
};

it("marks chat table HTML anchors as Markdown links", () => {
  const onFile = vi.fn();
  renderToStaticMarkup(
    createElement(Markdown, {
      streaming: false,
      text: "| Page |\n| --- |\n| [Open](./page.html?preview=1#intro) |",
      workspace: { cwd: "/shared" },
      onFile,
      onLink: vi.fn(),
    }),
  );
  expect(links).toHaveLength(1);
  links[0].onOpen?.();
  expect(onFile).toHaveBeenCalledWith(
    "/shared/page.html",
    { relative: true, fileUrl: "file:///shared/page.html?preview=1#intro" },
    "markdown-link",
  );
});

it.each([false, true])("opens complete spaced file destinations (streaming: %s)", (streaming) => {
  const document =
    "/Users/jiezhou/.zpi/workspace/draft-c2852ed4-5fca-4377-942c-0b2934304983/doc/【8.20】20261104 北京高端盘-资管&经纪人业绩规则.md";
  const cases = [
    [`[【8.20】20261104 北京高端盘-资管&经纪人业绩规则](${document})`, document, {}],
    [
      "[相对](./doc/北京 高端盘(终稿)&规则.md:12:3)",
      "/workspace/doc/北京 高端盘(终稿)&规则.md",
      { relative: true, line: 12, column: 3 },
    ],
    ["[Windows](C:\\My Files\\.config\\a&b.json)", "C:/My Files/.config/a&b.json", {}],
    ["[编码](./doc/订单%2520 汇总.md)", "/workspace/doc/订单%20 汇总.md", { relative: true }],
    ["[规范](</tmp/北京 高端盘.md>)", "/tmp/北京 高端盘.md", {}],
    [
      "| 文件 |\n| --- |\n| [表格](./doc/北京 高端盘.md) |",
      "/workspace/doc/北京 高端盘.md",
      { relative: true },
    ],
  ] as const;
  for (const [text, path, location] of cases) {
    links.length = 0;
    const onFile = vi.fn();
    renderToStaticMarkup(
      createElement(Markdown, {
        streaming,
        text,
        workspace: { cwd: "/workspace" },
        onFile,
        onLink: vi.fn(),
      }),
    );
    expect(links, text).toHaveLength(1);
    links[0].onOpen?.();
    expect(onFile, text).toHaveBeenCalledWith(path, location, "markdown-link");
  }
});

it("marks Markdown anchors inside tool previews without changing tool file chip intent", () => {
  const onFile = vi.fn();
  renderToStaticMarkup(createElement(ToolFilePreview, { block, workspace: { cwd: "/shared" }, onFile }));
  expect(links).toHaveLength(1);
  links[0].onOpen?.();
  expect(onFile).toHaveBeenCalledWith("/shared/page.html", { relative: true }, "markdown-link");
  onFile.mockClear();
  const chip = ToolFileChip({ block: { ...block, name: "read", argsText: '{"path":"page.html"}' }, onFile });
  chip?.props.onClick({ preventDefault: vi.fn(), stopPropagation: vi.fn() });
  expect(onFile).toHaveBeenCalledWith("page.html");
});

it("keeps write/edit file chips on their diff action", () => {
  const onFile = vi.fn(),
    onChanges = vi.fn();
  const chip = ToolFileChip({
    block: { ...block, status: "running", argsText: '{"path":"page.html"}' },
    onFile,
    onChanges,
  });
  chip?.props.onClick({ preventDefault: vi.fn(), stopPropagation: vi.fn() });
  expect(onChanges).toHaveBeenCalledWith("page.html", "tool");
  expect(onFile).not.toHaveBeenCalled();
});
