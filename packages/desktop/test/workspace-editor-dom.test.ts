import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { PreviewEditorButton } from "../src/renderer/PreviewEditorButton.tsx";
import { WorkspaceEditorButton } from "../src/renderer/WorkspaceEditorButton.tsx";
import type { Result } from "../src/shared/bridge.ts";
import type { EditorInfo } from "../src/shared/editors.ts";

const editors: EditorInfo[] = [
  { id: "vscode", name: "VS Code", iconDataUrl: "data:image/png;base64,code" },
  { id: "finder", name: "Finder", iconDataUrl: "data:image/png;base64,finder" },
  { id: "idea", name: "IntelliJ IDEA", iconDataUrl: "data:image/png;base64,idea" },
];
const getInstalledEditors = vi.fn<() => Promise<Result<EditorInfo[]>>>();
const openInEditor = vi.fn<() => Promise<Result<void>>>();
const fileAction = vi.fn<() => Promise<Result<void>>>();
const logError = vi.fn();
let root: Root;
let container: HTMLDivElement;

function query<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  expect(element, selector).not.toBeNull();
  return element as T;
}
const trigger = () => query<HTMLButtonElement>(".workspace-editor-select");
const items = () => [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')];
const click = async (element: HTMLElement) => {
  await act(async () => element.click());
};
const key = async (target: EventTarget, value: string) => {
  await act(async () => {
    target.dispatchEvent(new KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true }));
    // Roving focus defers movement so React can finish the current key event.
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  // FocusScope restores the trigger in a task after the closed content unmounts.
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
};
async function render(path = "README.md") {
  await act(async () => {
    root.render(
      createElement(
        "div",
        null,
        createElement(WorkspaceEditorButton, { sessionId: "workspace-session" }),
        createElement(PreviewEditorButton, { sessionId: "preview-session", path }),
      ),
    );
  });
  await act(async () => window.dispatchEvent(new Event("storage")));
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  getInstalledEditors.mockReset().mockResolvedValue({ ok: true, value: editors });
  openInEditor.mockReset().mockResolvedValue({ ok: true, value: undefined });
  fileAction.mockReset().mockResolvedValue({ ok: true, value: undefined });
  logError.mockReset();
  window.localStorage.clear();
  Object.defineProperty(window, "zpi", {
    configurable: true,
    value: { platform: "darwin", getInstalledEditors, openInEditor, fileAction, logError },
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

test("keeps the split trigger independent and uses the shared left-icon, right-check radio layout", async () => {
  await render();
  expect(query(".workspace-editor-group").getAttribute("data-platform")).toBe("darwin");
  expect(query(".workspace-editor-open").getAttribute("aria-label")).toBe("在 Finder 中打开");
  await act(async () => {
    trigger().dispatchEvent(new PointerEvent("pointerdown", { button: 0, bubbles: true }));
  });
  expect(trigger().getAttribute("aria-expanded")).toBe("true");
  expect(openInEditor).not.toHaveBeenCalled();
  const menu = query(".workspace-editor-menu");
  expect(menu.classList.contains("parity-menu")).toBe(true);
  expect(menu.classList.contains("selection-menu")).toBe(false);
  expect(menu.querySelector(".parity-menu-group")).not.toBeNull();
  expect(items().map((item) => item.textContent)).toEqual(["Finder", "VS Code", "IntelliJ IDEA"]);
  for (const item of items()) {
    expect(item.classList.contains("parity-menu-radio")).toBe(true);
    expect(item.classList.contains("menu-item")).toBe(false);
    expect(item.firstElementChild?.tagName).toBe("IMG");
  }
  const checked = query('[role="menuitemradio"][aria-checked="true"]');
  expect(checked.textContent).toBe("Finder");
  expect(checked.lastElementChild?.classList.contains("parity-menu-indicator")).toBe(true);
  expect(checked.querySelector("svg")?.getAttribute("width")).toBe("16");
  await key(menu, "Escape");
  expect(document.querySelector('[role="menu"]')).toBeNull();
  expect(trigger().getAttribute("aria-expanded")).toBe("false");
  expect(document.activeElement).toBe(trigger());
});

test("project editor selection persists while preview opening follows the system default", async () => {
  await render();
  await key(trigger(), "ArrowDown");
  await click(items()[2]);
  expect(openInEditor).toHaveBeenCalledExactlyOnceWith("workspace-session", ".", "idea");
  expect(window.localStorage.getItem("zpi-last-editor-id")).toBe("idea");
  expect(document.querySelector('[role="menu"]')).toBeNull();
  expect(query(".workspace-editor-open").getAttribute("aria-label")).toBe("在 IntelliJ IDEA 中打开");
  await click(query(".workspace-editor-open"));
  expect(openInEditor).toHaveBeenLastCalledWith("workspace-session", ".", "idea");
  await click(query('button[aria-label="使用默认程序打开"]'));
  expect(fileAction).toHaveBeenCalledExactlyOnceWith("preview-session", "README.md", "open");
  expect(openInEditor).toHaveBeenCalledTimes(2);
  await key(trigger(), "ArrowDown");
  expect(query('[role="menuitemradio"][aria-checked="true"]').textContent).toBe("IntelliJ IDEA");
  await click(items()[0]);
  expect(openInEditor).toHaveBeenLastCalledWith("workspace-session", ".", "finder");
  expect(openInEditor).toHaveBeenCalledTimes(3);
});

test.each(["README.md", "src/订单 #1.java"])(
  "preview opens %s with the system default even when VS Code is the stored project editor",
  async (path) => {
    window.localStorage.setItem("zpi-last-editor-id", "vscode");
    await render(path);
    const button = query<HTMLButtonElement>('button[aria-label="使用默认程序打开"]');
    expect(button.title).toBe("使用默认程序打开");
    await click(button);
    expect(fileAction).toHaveBeenCalledExactlyOnceWith("preview-session", path, "open");
    expect(openInEditor).not.toHaveBeenCalled();
    expect(window.localStorage.getItem("zpi-last-editor-id")).toBe("vscode");
  },
);

test("preview opening does not depend on ZPI discovering an installed editor", async () => {
  getInstalledEditors.mockResolvedValue({ ok: true, value: [] });
  await render();
  const button = query<HTMLButtonElement>('button[aria-label="使用默认程序打开"]');
  expect(button.disabled).toBe(false);
  await click(button);
  expect(openInEditor).not.toHaveBeenCalled();
  expect(fileAction).toHaveBeenCalledExactlyOnceWith("preview-session", "README.md", "open");
});

test("preview opening is disabled without a file path", async () => {
  await render("");
  const button = query<HTMLButtonElement>('button[aria-label="使用默认程序打开"]');
  expect(button.disabled).toBe(true);
  await click(button);
  expect(fileAction).not.toHaveBeenCalled();
});

test("default preview opening failures reach the existing error log", async () => {
  window.localStorage.setItem("zpi-last-editor-id", "vscode");
  fileAction.mockResolvedValue({ ok: false, error: { code: "storage", message: "Editor unavailable" } });
  await render();
  await click(query('button[aria-label="使用默认程序打开"]'));
  expect(logError).toHaveBeenCalledWith(
    expect.objectContaining({
      source: "open-default-file",
      message: expect.stringContaining("Editor unavailable"),
    }),
  );
});

test("keyboard navigation selects with Enter and outside dismissal never opens an application", async () => {
  await render();
  await key(trigger(), "ArrowDown");
  expect(document.activeElement).toBe(items()[0]);
  await key(items()[0], "ArrowDown");
  expect(document.activeElement).toBe(items()[1]);
  await key(items()[1], "Enter");
  expect(openInEditor).toHaveBeenCalledExactlyOnceWith("workspace-session", ".", "vscode");
  await key(trigger(), "ArrowDown");
  // Radix installs its outside pointer listener on the next task.
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  await act(async () => {
    document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerType: "mouse" }));
  });
  expect(document.querySelector('[role="menu"]')).toBeNull();
  expect(openInEditor).toHaveBeenCalledTimes(1);
});

test("asynchronous discovery preserves the stored preference without opening anything", async () => {
  let resolve!: (value: Result<EditorInfo[]>) => void;
  getInstalledEditors.mockReturnValue(new Promise((done) => (resolve = done)));
  window.localStorage.setItem("zpi-last-editor-id", "idea");
  await render();
  expect(document.querySelector(".workspace-editor-group")).toBeNull();
  await act(async () => resolve({ ok: true, value: editors }));
  expect(query(".workspace-editor-open").getAttribute("aria-label")).toBe("在 IntelliJ IDEA 中打开");
  expect(openInEditor).not.toHaveBeenCalled();
});

test("an unavailable preference falls back without overwriting it and open errors reach the existing log", async () => {
  window.localStorage.setItem("zpi-last-editor-id", "missing-editor");
  openInEditor.mockResolvedValue({
    ok: false,
    error: { code: "configuration", message: "Editor unavailable" },
  });
  await render();
  expect(query(".workspace-editor-open").getAttribute("aria-label")).toBe("在 Finder 中打开");
  expect(window.localStorage.getItem("zpi-last-editor-id")).toBe("missing-editor");
  await click(query(".workspace-editor-open"));
  expect(logError).toHaveBeenCalledWith(
    expect.objectContaining({
      source: "open-in-editor",
      message: expect.stringContaining("Editor unavailable"),
    }),
  );
});
