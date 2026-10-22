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
  document.getSelection()?.removeAllRanges();
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

it.each(["metaKey", "ctrlKey"] as const)(
  "%s + click opens file links with the default application and web links externally",
  async (modifier) => {
    const onFile = vi.fn();
    const onFileAction = vi.fn().mockResolvedValue(undefined);
    const onLink = vi.fn();
    await act(async () => {
      root.render(
        createElement(Markdown, {
          streaming: false,
          text: "[PDF](./report.pdf) [Folder](./src/) [Source](./main.ts:12:3) [HTML](./page.html?view=1#intro) [Web](http://localhost:3000)",
          workspace: { cwd: "/workspace" },
          onFile,
          onFileAction,
          onLink,
        }),
      );
    });
    await act(async () => {
      for (const link of container.querySelectorAll("button")) {
        link.dispatchEvent(new MouseEvent("click", { bubbles: true, [modifier]: true }));
      }
    });
    expect(onFile).not.toHaveBeenCalled();
    expect(onFileAction.mock.calls).toEqual([
      ["/workspace/report.pdf", "open", { relative: true }],
      ["/workspace/src", "open", { relative: true }],
      ["/workspace/main.ts", "open", { line: 12, column: 3, relative: true }],
      [
        "/workspace/page.html",
        "open",
        { relative: true, fileUrl: "file:///workspace/page.html?view=1#intro" },
      ],
    ]);
    expect(onLink).toHaveBeenCalledWith("http://localhost:3000/", { forceExternal: true });
  },
);

it("preserves selected file links on Command + click and shows default-open failures", async () => {
  const onFile = vi.fn();
  const onFileAction = vi.fn().mockRejectedValue(new Error("storage: 无法打开文件，请重试。"));
  await act(async () => {
    root.render(
      createElement(Markdown, {
        streaming: false,
        text: "[Report](./report.pdf)",
        workspace: { cwd: "/workspace" },
        onLink: vi.fn(),
        onFile,
        onFileAction,
      }),
    );
  });
  const link = container.querySelector<HTMLButtonElement>(".message-file-link");
  expect(link).not.toBeNull();
  const range = document.createRange();
  range.selectNodeContents(link as Node);
  document.getSelection()?.addRange(range);
  const click = async () => {
    await act(async () => {
      link?.dispatchEvent(new MouseEvent("click", { bubbles: true, metaKey: true }));
    });
  };
  await click();
  expect(onFileAction).not.toHaveBeenCalled();
  expect(document.getSelection()?.toString()).toBe("Report");
  document.getSelection()?.removeAllRanges();
  await click();
  expect(onFile).not.toHaveBeenCalled();
  expect(container.querySelector('[role="alert"]')?.textContent).toBe("无法打开文件，请重试。");
  onFileAction.mockResolvedValue(undefined);
  await click();
  expect(container.querySelector('[role="alert"]')).toBeNull();
});
