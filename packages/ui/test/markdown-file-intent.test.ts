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
