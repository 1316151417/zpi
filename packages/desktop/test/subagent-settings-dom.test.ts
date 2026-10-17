import { readFileSync } from "node:fs";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { Result } from "../src/shared/bridge.ts";
import type { SubagentCatalog } from "../src/shared/subagents.ts";

const state = vi.hoisted(() => ({
  selected: "session",
  settings: { providers: [] },
  projects: [{ id: "project", name: "Project" }],
  sessions: new Map([["session", { projectId: "project" }]]),
}));
vi.mock("../src/renderer/store.ts", () => ({
  useStore: (select: (value: typeof state) => unknown) => select(state),
  unwrap: (result: Result<unknown>) => {
    if (!result.ok) throw new Error(result.error.message);
    return result.value;
  },
}));

import { SubagentSettings } from "../src/renderer/SubagentSettings.tsx";

const catalog: SubagentCatalog = { agents: [], diagnostics: [] };
const listSubagents = vi.fn<() => Promise<Result<SubagentCatalog>>>();
const saveSubagent = vi.fn();
let root: Root;
let container: HTMLDivElement;
let style: HTMLStyleElement;
const query = <T extends Element>(selector: string): T => {
  const element = document.querySelector<T>(selector);
  expect(element, selector).not.toBeNull();
  return element as T;
};
const creates = () => [
  query<HTMLButtonElement>(".subagent-group-actions .primary"),
  query<HTMLButtonElement>(".subagent-empty .primary"),
];
const click = async (element: HTMLElement) => {
  await act(async () => element.click());
};
const button = (text: string) => {
  const element = [...container.querySelectorAll("button")].find((element) => element.textContent === text);
  expect(element, text).toBeDefined();
  return element as HTMLButtonElement;
};
async function render() {
  await act(async () => root.render(createElement(SubagentSettings)));
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  listSubagents.mockReset().mockResolvedValue({ ok: true, value: catalog });
  saveSubagent.mockReset();
  Object.defineProperty(window, "zpi", {
    configurable: true,
    value: { listSubagents, saveSubagent },
  });
  style = document.createElement("style");
  // This checks the cascade in DOM, not text layout, browser hover, or rendered pixels.
  style.textContent = [
    readFileSync(new URL("../../ui/src/tokens.css", import.meta.url), "utf8"),
    readFileSync(new URL("../../ui/src/styles.css", import.meta.url), "utf8"),
    readFileSync(new URL("../src/renderer/workbench.css", import.meta.url), "utf8"),
  ].join("\n");
  document.head.append(style);
  container = document.createElement("div");
  container.className = "settings-screen";
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  style.remove();
  document.documentElement.removeAttribute("data-theme");
  document.documentElement.style.removeProperty("--ui-font-size");
  vi.unstubAllGlobals();
});

test.each(["light", "dark"])(
  "both create entries share compact geometry and typography in %s",
  async (theme) => {
    document.documentElement.dataset.theme = theme;
    await render();
    for (const fontSize of [12, 14, 18]) {
      document.documentElement.style.setProperty("--ui-font-size", `${fontSize}px`);
      const appearances = creates().map((element) => {
        const css = getComputedStyle(element);
        return {
          iconWidth: element.querySelector("svg")?.getAttribute("width"),
          iconHeight: element.querySelector("svg")?.getAttribute("height"),
          height: css.height,
          padding: css.padding,
          gap: css.gap,
          borderRadius: css.borderRadius,
          fontSize: css.fontSize,
          fontWeight: css.fontWeight,
          display: css.display,
          alignItems: css.alignItems,
          justifyContent: css.justifyContent,
          background: css.backgroundColor,
          color: css.color,
          transition: css.transition,
        };
      });
      expect(appearances[1]).toEqual(appearances[0]);
      expect(appearances[0]).toMatchObject({
        iconWidth: "14",
        iconHeight: "14",
        height: "32px",
        padding: "0px 12px",
        gap: "4px",
        borderRadius: "8px",
        fontSize: `${fontSize}px`,
        fontWeight: "500",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
      });
    }
    const refresh = getComputedStyle(query('button[aria-label="刷新"]'));
    expect(refresh.width).toBe("32px");
    expect(refresh.padding).toBe("0px");
    expect(getComputedStyle(query(".subagent-empty")).padding).toBe("40px 16px");
  },
);

test.each([0, 1])(
  "create entry %i preserves repeated new/cancel/back flows without saving",
  async (index) => {
    await render();
    for (const dismiss of ["取消", "返回子智能体列表", "取消"]) {
      await click(creates()[index]);
      expect(query("h2").textContent).toBe("新建子智能体");
      expect(query<HTMLInputElement>('[aria-label="子智能体名称"]').value).toBe("");
      expect(query('[aria-label="子智能体作用域"]').textContent).toBe("个人");
      expect(button("保存").disabled).toBe(true);
      // The editor's intentionally larger save/cancel buttons are unaffected.
      expect(getComputedStyle(button("保存")).height).toBe("40px");
      await click(dismiss === "取消" ? button(dismiss) : query('[aria-label="返回子智能体列表"]'));
      expect(creates().every((element) => !element.disabled)).toBe(true);
    }
    expect(saveSubagent).not.toHaveBeenCalled();
  },
);

test("both create entries stay disabled during initial loading and refresh, then recover together", async () => {
  let resolve!: (result: Result<SubagentCatalog>) => void;
  listSubagents.mockImplementation(() => new Promise((done) => (resolve = done)));
  await render();
  expect(creates().every((element) => element.disabled)).toBe(true);
  await click(creates()[1]);
  expect(container.querySelector("form")).toBeNull();
  await act(async () => resolve({ ok: true, value: catalog }));
  expect(creates().every((element) => !element.disabled)).toBe(true);
  await click(query('[aria-label="刷新"]'));
  expect(creates().every((element) => element.disabled)).toBe(true);
  await click(creates()[0]);
  expect(container.querySelector("form")).toBeNull();
  await act(async () => resolve({ ok: true, value: catalog }));
  expect(creates().every((element) => !element.disabled)).toBe(true);
  expect(listSubagents).toHaveBeenCalledTimes(2);
});

test("workspace empty-state creation keeps the selected scope", async () => {
  await render();
  await act(async () => {
    query('[aria-label="子智能体列表作用域"]').dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
    );
  });
  const workspace = [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].find(
    (element) => element.textContent === "Project",
  );
  expect(workspace).toBeDefined();
  await click(workspace as HTMLElement);
  await click(creates()[1]);
  expect(query('[aria-label="子智能体作用域"]').textContent).toBe("Project");
  await click(button("取消"));
  expect(query('[aria-label="子智能体列表作用域"]').textContent).toBe("Project");
  expect(saveSubagent).not.toHaveBeenCalled();
});
