import { readFileSync } from "node:fs";
import * as Menu from "@radix-ui/react-dropdown-menu";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ChatComposer, Conversation } from "../../ui/src/components/Conversation.tsx";
import { SelectionReferenceChip } from "../../ui/src/components/ConversationSelections.tsx";
import { ComposerDraftStore } from "../../ui/src/components/InputContext.tsx";
import { ActionHint } from "../../ui/src/components/MessageActions.tsx";
import { UserQuestionCard } from "../src/renderer/UserQuestionCard.tsx";

let root: Root;
let container: HTMLDivElement;
const frames = new Map<number, FrameRequestCallback>();
const observers: {
  callback: ResizeObserverCallback;
  targets: Element[];
  disconnect: ReturnType<typeof vi.fn>;
}[] = [];
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  frames.clear();
  observers.length = 0;
  vi.stubGlobal("CSS", { ...CSS, highlights: new Map() });
  let frameId = 0;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.set(++frameId, callback);
    return frameId;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  vi.stubGlobal(
    "ResizeObserver",
    class {
      targets: Element[] = [];
      disconnect = vi.fn();
      constructor(callback: ResizeObserverCallback) {
        observers.push({ callback, targets: this.targets, disconnect: this.disconnect });
      }
      observe(element: Element) {
        this.targets.push(element);
      }
      unobserve() {}
    },
  );
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  document.body.replaceChildren();
  for (const element of document.head.querySelectorAll("style[data-audit-test]")) element.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function frame() {
  await act(async () => {
    const pending = [...frames.values()];
    frames.clear();
    for (const callback of pending) callback(0);
  });
}
async function settleFocus() {
  // Radix FocusScope restores focus in its deferred unmount cleanup.
  await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
}
function element(selector: string, parent: ParentNode = container) {
  const result = parent.querySelector<HTMLElement>(selector);
  if (!result) throw new Error(`Missing ${selector}`);
  return result;
}

it.each(["hidden", "inert", "aria-hidden", "visibility", "visible"])(
  "composer autofocus respects only visible question dialogs (%s)",
  async (mode) => {
    // happy-dom has no layout; supply a rendered rect so the visibility guard is exercised.
    vi.spyOn(HTMLElement.prototype, "getClientRects").mockImplementation(
      () => [new DOMRect(0, 0, 100, 100)] as unknown as DOMRectList,
    );
    const question = createElement(UserQuestionCard, {
      sessionId: "retained-child",
      visible: false,
      request: {
        id: "question",
        questions: [
          {
            question: "选择方案",
            header: "方案",
            multiSelect: false,
            options: [
              { label: "一", description: "第一个方案" },
              { label: "二", description: "第二个方案" },
            ],
          },
        ],
      },
    });
    await act(async () =>
      root.render(
        createElement(
          "div",
          null,
          createElement(
            "aside",
            {
              hidden: mode === "hidden",
              inert: mode === "inert",
              "aria-hidden": mode === "aria-hidden" ? true : undefined,
              style: { visibility: mode === "visibility" ? "hidden" : "visible" },
            },
            question,
          ),
          createElement(ChatComposer, {
            sessionId: "selected-main",
            busy: false,
            onSubmit: async () => {},
            onStop() {},
            draftStorage: new ComposerDraftStore(),
          }),
        ),
      ),
    );
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
    await frame();
    const editor = container.querySelector(".mention-editor");
    expect(editor).not.toBeNull();
    if (mode === "visible") expect(document.activeElement).not.toBe(editor);
    else expect(document.activeElement).toBe(editor);
  },
);

async function commentChip() {
  await act(async () =>
    root.render(
      createElement(SelectionReferenceChip, {
        references: [
          {
            path: "/file.ts",
            text: "source",
            sourceKey: 'file-comment:{"start":1,"end":1,"comment":"note"}',
          },
        ],
        onChange() {},
        onFile() {},
      }),
    ),
  );
  return element("[data-file-comment-count]");
}
async function hover(pill: HTMLElement) {
  await act(async () => {
    pill.dispatchEvent(new PointerEvent("pointerover", { bubbles: true, pointerType: "mouse" }));
  });
}
it.each([false, true])(
  "comment Escape restores the chip after keyboard activation (hover first=%s)",
  async (hoverFirst) => {
    const pill = await commentChip();
    if (hoverFirst) await hover(pill);
    await act(async () => {
      pill.focus();
      pill.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    const button = element('[aria-label="评论内容"] button', document);
    await act(async () => {
      button.focus();
      button.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    await settleFocus();
    expect(document.querySelector('[aria-label="评论内容"]')).toBeNull();
    expect(document.activeElement).toBe(pill);
  },
);
it("a hover-only comment preview does not steal the editor's focus when dismissed", async () => {
  const pill = await commentChip();
  const editor = document.createElement("textarea");
  document.body.append(editor);
  editor.focus();
  await hover(pill);
  await act(async () => {
    editor.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  });
  await settleFocus();
  expect(document.querySelector('[aria-label="评论内容"]')).toBeNull();
  expect(document.activeElement).toBe(editor);
});
it("closing an interactive comment by moving focus outside preserves the new focus target", async () => {
  const pill = await commentChip();
  await hover(pill);
  await act(async () => {
    pill.focus();
    pill.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });
  const outside = document.createElement("textarea");
  document.body.append(outside);
  await act(async () => outside.focus());
  await settleFocus();
  expect(document.querySelector('[aria-label="评论内容"]')).toBeNull();
  expect(document.activeElement).toBe(outside);
});

it("the project menu stays visible when its tooltip has a closed data-state", async () => {
  const css = readFileSync(new URL("../src/renderer/workbench.css", import.meta.url), "utf8");
  const style = document.createElement("style");
  style.dataset.auditTest = "sidebar";
  style.textContent = css.slice(
    css.indexOf(".sidebar .project-row-action {"),
    css.indexOf(".sidebar .project-row-action:hover {"),
  );
  document.head.append(style);
  const renderMenu = (open: boolean) =>
    createElement(
      "div",
      { className: "sidebar" },
      createElement(
        Menu.Root,
        { open },
        createElement(ActionHint, {
          label: "更多",
          appearance: "control",
          // biome-ignore lint/correctness/noChildrenProp: ActionHint requires children in its props type.
          children: createElement(Menu.Trigger, { className: "project-row-action" }, "More"),
        }),
        createElement(
          Menu.Portal,
          null,
          createElement(Menu.Content, null, createElement(Menu.Item, null, "移除")),
        ),
      ),
    );
  await act(async () => root.render(renderMenu(true)));
  const trigger = element(".project-row-action");
  expect(trigger.getAttribute("aria-expanded")).toBe("true");
  expect(trigger.getAttribute("data-state")).toBe("closed");
  expect(getComputedStyle(trigger).opacity).toBe("1");
  await act(async () => root.render(renderMenu(false)));
  expect(getComputedStyle(trigger).opacity).toBe("0");
});

it.each([true, false])(
  "conversation shares real column bounds only with its sibling composer (%s)",
  async (composer) => {
    await act(async () =>
      root.render(
        createElement(
          "section",
          null,
          createElement(Conversation, {
            view: { sessionId: "layout", title: "Layout", seq: 0, runs: [] },
            onLink() {},
            persistReading: false,
          }),
          composer ? createElement("div", { className: "composer-container" }) : null,
        ),
      ),
    );
    const owner = element("section");
    const viewport = element(".conversation");
    const column = element(".conversation-inner");
    const observer = observers.find((candidate) => candidate.targets.includes(column));
    if (!observer) throw new Error("Column resize observer not registered");
    let width = 819;
    let gutter = 15;
    vi.spyOn(viewport, "offsetWidth", "get").mockImplementation(() => 900 + gutter);
    vi.spyOn(viewport, "clientWidth", "get").mockReturnValue(900);
    vi.spyOn(column, "getBoundingClientRect").mockImplementation(() => new DOMRect(0, 0, width, 100));
    column.style.marginLeft = "48px";
    const notify = () => act(async () => observer.callback([], {} as ResizeObserver));
    await notify();
    const writes = vi.spyOn(owner.style, "setProperty");
    await notify();
    expect(writes).not.toHaveBeenCalled();
    expect(owner.style.getPropertyValue("--conversation-column-width")).toBe(composer ? "819px" : "");
    expect(owner.style.getPropertyValue("--conversation-scrollbar-width")).toBe(composer ? "15px" : "");
    expect(owner.style.getPropertyValue("--conversation-column-left")).toBe("");
    // Hidden retained panes keep the last usable bounds; showing/resizing measures anew.
    width = 0;
    await notify();
    expect(owner.style.getPropertyValue("--conversation-column-width")).toBe(composer ? "819px" : "");
    width = 834;
    gutter = 0;
    column.style.marginLeft = "0px";
    await notify();
    expect(owner.style.getPropertyValue("--conversation-column-width")).toBe(composer ? "834px" : "");
    expect(owner.style.getPropertyValue("--conversation-scrollbar-width")).toBe(composer ? "0px" : "");
    await act(async () => root.render(null));
    expect(observer.disconnect).toHaveBeenCalledOnce();
    expect(owner.style.getPropertyValue("--conversation-column-width")).toBe("");
    expect(owner.style.getPropertyValue("--conversation-scrollbar-width")).toBe("");
  },
);

it("normal chat keeps warning timers while typing and clears warnings on expiry or send", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const drafts = new ComposerDraftStore();
  const draft = { text: "保留草稿", attachments: [], fileReferences: [], pending: 0, error: "附件太多" };
  drafts.set("notice", draft);
  const sent = Promise.withResolvers<void>();
  const onSubmit = vi.fn(() => sent.promise);
  await act(async () =>
    root.render(
      createElement(ChatComposer, {
        sessionId: "notice",
        busy: false,
        draftStorage: drafts,
        onSubmit,
        onStop() {},
      }),
    ),
  );
  expect(container.querySelectorAll(".composer-actions .input-notice button")).toHaveLength(1);
  const editor = element(".mention-editor");
  const type = (text: string) =>
    act(async () => {
      editor.textContent = text;
      editor.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
    });
  await act(async () => vi.advanceTimersByTime(1000));
  await type("保留草稿a");
  expect(drafts.get("notice")?.text).toBe("保留草稿a");
  expect(document.querySelector('[role="tooltip"]')).not.toBeNull();
  expect(container.querySelector(".input-notice-trigger")).not.toBeNull();
  await act(async () => vi.advanceTimersByTime(2000));
  expect(document.querySelector('[role="tooltip"]')).toBeNull();
  await act(async () => vi.advanceTimersByTime(1000));
  await type("保留草稿ab");
  expect(document.querySelector('[role="tooltip"]')).toBeNull();
  expect(container.querySelector(".input-notice-trigger")).not.toBeNull();
  await act(async () => vi.advanceTimersByTime(3999));
  expect(container.querySelector(".input-notice-trigger")).not.toBeNull();
  await act(async () => vi.advanceTimersByTime(1));
  expect(container.querySelector(".input-notice")).toBeNull();
  expect(drafts.get("notice")?.text).toBe("保留草稿ab");
  await act(async () => drafts.set("notice", { ...draft }));
  expect(document.querySelector('[role="tooltip"]')).not.toBeNull();
  await act(async () => container.querySelector<HTMLButtonElement>("button.send")?.click());
  expect(onSubmit).toHaveBeenCalledOnce();
  expect(container.querySelector(".input-notice")).toBeNull();
  await act(async () => sent.resolve());
});

it("repeated normal-chat send failures reopen the details for a fresh interval", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const drafts = new ComposerDraftStore();
  drafts.set("retry-notice", { text: "重试", attachments: [], fileReferences: [], pending: 0 });
  const onSubmit = async () => {
    const draft = drafts.get("retry-notice");
    if (draft) drafts.set("retry-notice", { ...draft, error: "发送失败" });
    throw new Error("发送失败");
  };
  await act(async () =>
    root.render(
      createElement(ChatComposer, {
        sessionId: "retry-notice",
        busy: false,
        draftStorage: drafts,
        onSubmit,
        onStop() {},
      }),
    ),
  );
  const send = () => act(async () => container.querySelector<HTMLButtonElement>("button.send")?.click());
  await send();
  await act(async () => vi.advanceTimersByTime(3000));
  expect(document.querySelector('[role="tooltip"]')).toBeNull();
  await send();
  expect(document.querySelector('[role="tooltip"]')).not.toBeNull();
  await act(async () => vi.advanceTimersByTime(3000));
  expect(document.querySelector('[role="tooltip"]')).toBeNull();
  expect(drafts.get("retry-notice")?.error).toBe("发送失败");
});
