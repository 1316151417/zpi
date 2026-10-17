import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { PublicSettings, WebSearchSettingsInput } from "../src/shared/bridge.ts";

const mocks = vi.hoisted(() => ({
  state: {} as { settings: { webSearch: PublicSettings["webSearch"]; capabilities: { webSearch: boolean } } },
  listeners: new Set<() => void>(),
  save: vi.fn(),
  reveal: vi.fn(),
}));
vi.mock("../src/renderer/store.ts", async () => {
  const { useSyncExternalStore } = await import("react");
  return {
    useStore: Object.assign(
      (select: (state: typeof mocks.state) => unknown) =>
        useSyncExternalStore(
          (listener) => {
            mocks.listeners.add(listener);
            return () => {
              mocks.listeners.delete(listener);
            };
          },
          () => select(mocks.state),
        ),
      {
        setState: (state: typeof mocks.state) => {
          mocks.state = state;
          for (const listener of mocks.listeners) listener();
        },
      },
    ),
    unwrap: (result: { ok: boolean; value?: unknown; error?: { message: string } }) => {
      if (!result.ok) throw new Error(result.error?.message);
      return result.value;
    },
  };
});

import { WebSearchSettings } from "../src/renderer/WebSearchSettings.tsx";

const secret = "fake-saved-web-secret-0123456789-abcdefghijklmnopqrstuvwxyz";
let root: Root;
let container: HTMLDivElement;
let stored: string;
let unmounted: boolean;
const query = <T extends Element>(selector: string) => {
  const node = document.querySelector<T>(selector);
  expect(node, selector).not.toBeNull();
  return node as T;
};
const input = () => query<HTMLInputElement>("#web-search-api-key");
const eye = () => query<HTMLButtonElement>(".credential-input button");
const button = (label: string) => {
  const node = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (item) => item.textContent === label,
  );
  expect(node, label).toBeDefined();
  return node as HTMLButtonElement;
};
const click = async (node: HTMLElement) => {
  await act(async () => {
    node.click();
  });
};
const focus = async () => {
  await act(async () => {
    input().focus();
  });
};
const type = async (text: string) => {
  await act(async () => {
    // Native setter bypasses React's value tracker, exactly as a browser input edit does.
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set?.call(input(), text);
    input().dispatchEvent(new Event("input", { bubbles: true }));
  });
};
const keyboard = async (node: HTMLElement, key: string) => {
  await act(async () => {
    node.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
  });
};
async function rerenderSettings(patch: Partial<PublicSettings["webSearch"]> = {}) {
  await act(async () => {
    mocks.state = {
      ...mocks.state,
      settings: { ...mocks.state.settings, webSearch: { ...mocks.state.settings.webSearch, ...patch } },
    };
    for (const listener of mocks.listeners) listener();
  });
}
async function openRemoval() {
  const trigger = query<HTMLButtonElement>(".provider-more");
  await keyboard(trigger, "Enter");
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  await click(query<HTMLElement>(".provider-action-delete"));
}
function deferred() {
  let resolve!: (value: { ok: true; value: { apiKey: string } }) => void;
  const promise = new Promise<{ ok: true; value: { apiKey: string } }>((done) => {
    resolve = done;
  });
  mocks.reveal.mockReturnValue(promise);
  return async () => {
    await act(async () => {
      resolve({ ok: true, value: { apiKey: secret } });
    });
  };
}
beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  stored = secret;
  unmounted = false;
  mocks.state = {
    settings: {
      webSearch: {
        provider: "deepseek",
        enabled: true,
        hasApiKey: true,
        apiKeyLength: secret.length,
        credentialsPersisted: true,
        credentialsLocked: false,
      },
      capabilities: { webSearch: true },
    },
  };
  mocks.listeners.clear();
  mocks.reveal.mockReset().mockImplementation(async () => ({ ok: true, value: { apiKey: stored } }));
  mocks.save.mockReset().mockImplementation(async (value: WebSearchSettingsInput) => {
    if (value.apiKey !== undefined) stored = value.apiKey;
    return {
      ok: true,
      value: {
        ...mocks.state.settings,
        webSearch: {
          ...mocks.state.settings.webSearch,
          ...(value.enabled === undefined ? {} : { enabled: value.enabled }),
          hasApiKey: Boolean(stored),
          apiKeyLength: stored.length,
        },
      },
    };
  });
  Object.assign(window, { zpi: { saveWebSearch: mocks.save, getWebSearchCredentials: mocks.reveal } });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root.render(createElement(WebSearchSettings));
  });
});
afterEach(async () => {
  if (!unmounted) await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test("saved key has real-length native password masking and no automatic credential read", () => {
  expect(input().value).toBe("*".repeat(secret.length));
  expect(input().type).toBe("password");
  expect(eye().disabled).toBe(false);
  expect(mocks.reveal).not.toHaveBeenCalled();
  expect(container.innerHTML).not.toContain(secret);
  expect(button("保存").disabled).toBe(true);
});
test("eye reveals the saved key, supports focus/select, hides and never marks it dirty", async () => {
  await click(eye());
  expect(mocks.reveal).toHaveBeenCalledTimes(1);
  expect(input().value).toBe(secret);
  expect(input().type).toBe("text");
  await focus();
  input().select();
  expect(input().selectionEnd).toBe(secret.length);
  expect(input().value).toBe(secret);
  await click(button("保存"));
  expect(mocks.save).not.toHaveBeenCalled();
  await click(eye());
  expect(input().value).toBe("*".repeat(secret.length));
  expect(input().type).toBe("password");
  expect(container.innerHTML).not.toContain(secret);
});
test("genuine editing of the revealed key produces a replacement and saves once", async () => {
  await click(eye());
  await focus();
  await type(`${secret}-replacement`);
  expect(button("保存").disabled).toBe(false);
  await click(button("保存"));
  expect(mocks.save).toHaveBeenCalledExactlyOnceWith({
    provider: "deepseek",
    apiKey: `${secret}-replacement`,
  });
  expect(input().value).toBe("*".repeat(stored.length));
  expect(input().type).toBe("password");
});
test("masked focus starts a clean draft, Escape blurs and no mask is saved", async () => {
  await focus();
  expect(input().value).toBe("");
  await type("fake-new-key");
  await keyboard(input(), "Escape");
  expect(document.activeElement).not.toBe(input());
  expect(input().value).toBe("*".repeat(secret.length));
  await type(`${input().value}x`);
  expect(button("保存").disabled).toBe(true);
  await focus();
  await type("***");
  expect(button("保存").disabled).toBe(true);
  await click(button("取消编辑"));
  expect(mocks.save).not.toHaveBeenCalled();
});
test("empty draft preserves saved key and reveal after cancelled editing still works", async () => {
  await focus();
  await type("fake-replacement");
  await type("");
  await act(async () => input().blur());
  expect(input().value).toBe("*".repeat(secret.length));
  await click(eye());
  expect(input().value).toBe(secret);
  expect(mocks.save).not.toHaveBeenCalled();
});
for (const action of [
  "hide",
  "edit",
  "settings",
  "locked",
  "disable",
  "remove",
  "unmount",
  "blur",
  "visibility",
] as const) {
  test(`late reveal response is discarded after ${action}`, async () => {
    const finish = deferred();
    await click(eye());
    expect(input().getAttribute("aria-busy")).toBe("true");
    if (action === "hide") await click(eye());
    if (action === "edit") {
      await focus();
      await type("fake-new-key");
    }
    if (action === "settings") await rerenderSettings();
    if (action === "locked")
      await rerenderSettings({ hasApiKey: false, apiKeyLength: 0, credentialsLocked: true });
    if (action === "disable") await click(query<HTMLInputElement>('[role="switch"]'));
    if (action === "remove") await openRemoval();
    if (action === "unmount") {
      await act(async () => root.unmount());
      unmounted = true;
    }
    if (action === "blur") await act(async () => window.dispatchEvent(new Event("blur")));
    if (action === "visibility") {
      vi.spyOn(document, "hidden", "get").mockReturnValue(true);
      await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    }
    await finish();
    expect(document.body.innerHTML).not.toContain(secret);
    if (!unmounted && action !== "edit") expect(input().value).not.toBe(secret);
    if (action === "edit") expect(input().value).toBe("fake-new-key");
  });
}
test("an older reveal cannot overwrite a newer request or reset its loading state", async () => {
  const first = deferred();
  await click(eye());
  await click(eye());
  const second = deferred();
  await click(eye());
  await first();
  expect(input().getAttribute("aria-busy")).toBe("true");
  expect(input().value).not.toBe(secret);
  await second();
  expect(input().value).toBe(secret);
});
test("settings refresh clears revealed data but preserves a user replacement", async () => {
  await click(eye());
  await rerenderSettings();
  expect(input().value).not.toBe(secret);
  await focus();
  await type("fake-unsaved-replacement");
  await rerenderSettings();
  expect(input().value).toBe("fake-unsaved-replacement");
  expect(input().type).toBe("password");
});
test("disabled provider can reveal its key, and its switch never writes a displayed key", async () => {
  await rerenderSettings({ enabled: false });
  await click(eye());
  expect(input().value).toBe(secret);
  await click(query<HTMLInputElement>('[role="switch"]'));
  expect(mocks.save).toHaveBeenCalledExactlyOnceWith({ provider: "deepseek", enabled: true });
  expect(input().value).not.toBe(secret);
});
test("remove uses the shared more menu and confirmation; cancel preserves, confirm deletes", async () => {
  await click(eye());
  await openRemoval();
  expect(input().value).not.toBe(secret);
  await click(button("取消esc"));
  expect(mocks.save).not.toHaveBeenCalled();
  await openRemoval();
  await click(button("确认移除"));
  expect(mocks.save).toHaveBeenCalledExactlyOnceWith({ provider: "deepseek", apiKey: "" });
  expect(input().value).toBe("");
  expect(document.querySelector(".provider-more")).toBeNull();
});
test("locked credentials use an honest empty unavailable state", async () => {
  await rerenderSettings({ hasApiKey: false, credentialsLocked: true, apiKeyLength: 0 });
  expect(input().value).toBe("");
  expect(input().disabled).toBe(true);
  expect(eye().disabled).toBe(true);
  await click(eye());
  expect(mocks.reveal).not.toHaveBeenCalled();
});
test("credential failures never echo arbitrary errors or fake secrets", async () => {
  mocks.reveal.mockResolvedValue({ ok: false, error: { code: "INTERNAL", message: secret } });
  await click(eye());
  expect(document.body.textContent).not.toContain(secret);
  expect(document.body.textContent).toContain("无法读取已保存的 API Key");
  await focus();
  await type("fake-unsaved-replacement");
  mocks.save.mockRejectedValue(new Error(secret));
  await click(button("保存"));
  expect(document.body.textContent).not.toContain(secret);
  expect(input().value).toBe("fake-unsaved-replacement");
});

test("two immediate eye activations cancel the pending read without starting another", async () => {
  const finish = deferred();
  await act(async () => {
    eye().click();
    eye().click();
  });
  expect(mocks.reveal).toHaveBeenCalledTimes(1);
  await finish();
  expect(input().type).toBe("password");
  expect(input().value).not.toBe(secret);
});
test("eye is keyboard focusable and semantic activation reveals and hides", async () => {
  // Happy DOM dispatches DOM events but does not synthesize the browser's Enter/Space click.
  // Dispatch the native activation click after the key events, without calling component handlers.
  for (const key of ["Enter", " "]) {
    await act(async () => {
      eye().focus();
      expect(document.activeElement).toBe(eye());
      eye().dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
      eye().dispatchEvent(new KeyboardEvent("keyup", { key, bubbles: true }));
      eye().click();
    });
    expect(eye().getAttribute("aria-pressed")).toBe(key === "Enter" ? "true" : "false");
  }
  expect(input().type).toBe("password");
});
test("window blur clears saved plaintext and allows a fresh edit on refocus", async () => {
  await click(eye());
  await focus();
  await act(async () => window.dispatchEvent(new Event("blur")));
  expect(document.activeElement).not.toBe(input());
  expect(input().value).not.toBe(secret);
  await focus();
  expect(input().value).toBe("");
  await type("fake-refocused-replacement");
  expect(button("保存").disabled).toBe(false);
});
test("a removal failure is shown inside the dialog, then retry can succeed", async () => {
  mocks.save.mockResolvedValueOnce({ ok: false, error: { code: "configuration", message: secret } });
  await openRemoval();
  const dialog = query<HTMLElement>('[role="dialog"]');
  expect(document.activeElement).toBe(button("确认移除"));
  await keyboard(dialog, "Enter");
  expect(dialog.querySelector('[role="alert"]')?.textContent).toContain("无法保存联网搜索设置");
  expect(dialog.textContent).not.toContain(secret);
  expect(stored).toBe(secret);
  await click(button("确认移除"));
  expect(stored).toBe("");
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});
test("pending save blocks repeated submissions and Escape dismissal", async () => {
  let finish!: () => void;
  mocks.save.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = () =>
          resolve({
            ok: true,
            value: {
              ...mocks.state.settings,
              webSearch: { ...mocks.state.settings.webSearch, hasApiKey: false, apiKeyLength: 0 },
            },
          });
      }),
  );
  await openRemoval();
  await click(button("确认移除"));
  await keyboard(query<HTMLElement>('[role="dialog"]'), "Escape");
  await click(button("确认移除"));
  expect(mocks.save).toHaveBeenCalledTimes(1);
  expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  await act(async () => finish());
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});
test("form Enter submission saves only typed replacement and then clears its plaintext", async () => {
  await focus();
  await type("fake-enter-replacement");
  await keyboard(input(), "Enter");
  await act(async () => query<HTMLFormElement>("form").requestSubmit());
  expect(mocks.save).toHaveBeenCalledExactlyOnceWith({
    provider: "deepseek",
    apiKey: "fake-enter-replacement",
  });
  expect(input().type).toBe("password");
  expect(input().value).toBe("*".repeat(stored.length));
});

test("settings replacement blurs saved display but does not interrupt a focused draft", async () => {
  await click(eye());
  await focus();
  await rerenderSettings();
  expect(document.activeElement).not.toBe(input());
  expect(input().value).not.toBe(secret);
  await focus();
  await type("fake-still-editable");
  await rerenderSettings();
  expect(document.activeElement).toBe(input());
  expect(input().value).toBe("fake-still-editable");
  await type("fake-still-editable-more");
  expect(input().value).toBe("fake-still-editable-more");
});

test("DOM harness preserves isolated HOME and blocks resource fetches", async () => {
  expect(process.env.ZPI_TEST_MODE).toBe("1");
  expect(process.env.HOME).toContain("zpi-unit-");
  expect(document.doctype?.name).toBe("html");
  await expect(window.fetch("https://example.com/never-sent")).rejects.toThrow(
    "DOM test network access is disabled",
  );
});
