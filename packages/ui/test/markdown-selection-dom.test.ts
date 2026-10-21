import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Markdown } from "../src/components/Markdown.tsx";

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it("preserves selected Markdown nodes across callback and workspace updates and uses current routing", async () => {
  const render = async (cwd: string, onFile = vi.fn(), onLink = vi.fn()) => {
    await act(async () => {
      root.render(
        createElement(Markdown, {
          streaming: false,
          text: "UCID：**1000000031247413** 操作，`部分代码` [文件](./notes.md) [网页](https://example.com)",
          workspace: { cwd },
          onFile,
          onLink,
          onFileAction: vi.fn(),
        }),
      );
    });
  };
  await render("/before");
  const selector = "p, strong, code, .message-file-link, .message-web-link";
  const nodes = [...container.querySelectorAll(selector)];
  expect(nodes).toHaveLength(5);
  const range = document.createRange();
  range.setStart(nodes[1].firstChild as Text, 7);
  range.setEnd(nodes[0].childNodes[2], 3);
  document.getSelection()?.addRange(range);

  const onFile = vi.fn(),
    onLink = vi.fn();
  await render("/after", onFile, onLink);
  const updated = [...container.querySelectorAll(selector)];
  for (const [index, node] of nodes.entries()) expect(updated[index]).toBe(node);
  expect(document.getSelection()?.toString()).toBe("031247413 操作");
  document.getSelection()?.removeAllRanges();
  await act(async () => {
    container.querySelector<HTMLButtonElement>(".message-file-link")?.click();
    container.querySelector<HTMLButtonElement>(".message-web-link")?.click();
  });
  expect(onFile).toHaveBeenCalledWith("/after/notes.md", { relative: true }, "markdown-link");
  expect(onLink).toHaveBeenCalledWith("https://example.com/", { forceExternal: false });
});
