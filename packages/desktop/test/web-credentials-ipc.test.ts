import type { EventEmitter } from "node:events";
import { afterAll, beforeAll, beforeEach, expect, test, vi } from "vitest";
import type { DesktopBridge, Result } from "../src/shared/bridge.ts";
import { methods } from "../src/shared/bridge.ts";

type CallHandler = (event: unknown, method: unknown, args: unknown) => Promise<Result<unknown>>;
const fake = vi.hoisted(() => {
  const webContents = {
    mainFrame: {},
    on: vi.fn(),
    once: vi.fn(),
    send: vi.fn(),
    setWindowOpenHandler: vi.fn(),
    session: { setPermissionRequestHandler: vi.fn(), setPermissionCheckHandler: vi.fn() },
  };
  return {
    window: { webContents, on: vi.fn() },
    handle: vi.fn(),
    expose: vi.fn(),
    invoke: vi.fn(),
    fetch: vi.fn(() => {
      throw new Error("Network is forbidden in credential reveal tests");
    }),
    writeError: vi.fn(),
    loadRenderer: vi.fn(),
    settings: {
      get: vi.fn(() => ({
        interface: { theme: "light" },
        shortcuts: { enabled: false },
        providers: [],
        quickChat: { defaultSelection: null },
      })),
      saveQuickChatSettings: vi.fn(),
      getWebSearchCredentials: vi.fn(),
      getProviderCredentials: vi.fn(),
    },
  };
});
vi.mock("electron", () => ({
  app: {
    isPackaged: false,
    commandLine: { appendSwitch: vi.fn() },
    setName: vi.fn(),
    setPath: vi.fn(),
    getPath: () => "/unit-test-only",
    on: vi.fn(),
    once: vi.fn(),
    requestSingleInstanceLock: () => true,
    whenReady: async () => {},
    quit: vi.fn(),
  },
  clipboard: {},
  dialog: {},
  globalShortcut: {},
  ipcMain: { handle: fake.handle, on: vi.fn() },
  ipcRenderer: { invoke: fake.invoke, on: vi.fn() },
  contextBridge: { exposeInMainWorld: fake.expose },
  webUtils: {},
  Menu: { setApplicationMenu: vi.fn() },
  nativeTheme: { themeSource: "light", on: vi.fn() },
  net: { fetch: fake.fetch },
  safeStorage: {},
  screen: { getPrimaryDisplay: () => ({ workAreaSize: { width: 1200, height: 800 } }) },
  shell: {},
}));
vi.mock("../src/main/automation.ts", () => ({
  createDesktopWindow: () => fake.window,
  testMode: true,
  hiddenTestMode: true,
}));
vi.mock("../src/main/storage.ts", () => ({
  SettingsStore: class {
    get = fake.settings.get;
    saveQuickChatSettings = fake.settings.saveQuickChatSettings;
    getWebSearchCredentials = fake.settings.getWebSearchCredentials;
    getProviderCredentials = fake.settings.getProviderCredentials;
  },
}));
vi.mock("../src/main/state-store.ts", () => ({
  StateStore: class {
    close() {}
  },
}));
vi.mock("../src/main/storage-generation.ts", () => ({
  openStorageGeneration: () => ({ directory: "/unit-test-only", close: vi.fn() }),
}));
vi.mock("../src/main/error-log.ts", () => ({
  ErrorLog: class {
    write = fake.writeError;
  },
}));
vi.mock("../src/main/session-host.ts", () => ({
  SessionHost: class {
    async init() {}
    subscribe() {}
  },
}));
vi.mock("../src/main/chatgpt-auth.ts", () => ({ ChatGPTAuth: class {} }));
vi.mock("../src/main/pane-services.ts", () => ({ PaneServices: class {} }));
vi.mock("../src/main/preview-pdf-export.ts", () => ({ PreviewPdfExporter: class {}, previewPdfOptions: {} }));
vi.mock("../src/main/task-notifications.ts", () => ({ TaskNotifications: class {} }));
vi.mock("../src/main/web-source-icons.ts", () => ({ WebSourceIcons: class {} }));
vi.mock("../src/main/shortcut-modifier.ts", () => ({
  ShortcutModifier: class {
    observe() {}
    reset() {}
  },
}));
vi.mock("../src/main/shortcut-controller.ts", () => ({
  ShortcutController: class {
    initialize() {}
  },
  forwardBrowserShortcut: vi.fn(),
  setWindowMenuShortcutsIgnored: vi.fn(),
  toggleShortcutWindow: vi.fn(),
}));
vi.mock("../src/main/load-renderer.ts", () => ({ loadRenderer: fake.loadRenderer }));

const processEvents = ["uncaughtExceptionMonitor", "unhandledRejection", "SIGTERM", "SIGINT"] as const;
const processEmitter: EventEmitter = process;
const originalListeners = new Map(
  processEvents.map((event) => [event, new Set(processEmitter.listeners(event))]),
);
let call: CallHandler;
let quickCall: CallHandler;
let bridge: DesktopBridge;
const authorized = { sender: fake.window.webContents, senderFrame: fake.window.webContents.mainFrame };
beforeAll(async () => {
  await import("../src/main/index.ts");
  await vi.waitFor(() => expect(fake.loadRenderer).toHaveBeenCalledOnce());
  expect(fake.writeError).not.toHaveBeenCalled();
  expect(fake.handle.mock.calls.map(([channel]) => channel)).toEqual(["zpi:quick-chat", "zpi:call"]);
  call = fake.handle.mock.calls.find(([channel]) => channel === "zpi:call")?.[1] as CallHandler;
  quickCall = fake.handle.mock.calls.find(([channel]) => channel === "zpi:quick-chat")?.[1] as CallHandler;
  await import("../src/preload/index.ts");
  bridge = fake.expose.mock.calls[0][1] as DesktopBridge;
  expect(fake.invoke).not.toHaveBeenCalled();
  expect(fake.fetch).not.toHaveBeenCalled();
});
afterAll(() => {
  for (const event of processEvents) {
    for (const listener of processEmitter.listeners(event)) {
      if (!originalListeners.get(event)?.has(listener))
        processEmitter.removeListener(event, listener as (...args: unknown[]) => void);
    }
  }
});
beforeEach(() => {
  vi.clearAllMocks();
  fake.settings.getWebSearchCredentials.mockReset();
});

test("preload reveals credentials only when explicitly called, through the zero-argument allowlisted method", async () => {
  expect(methods).toContain("getWebSearchCredentials");
  expect(fake.invoke).not.toHaveBeenCalled();
  const response = { ok: true, value: { apiKey: "web-ipc-fake-key" } };
  fake.invoke.mockResolvedValueOnce(response);
  await expect(bridge.getWebSearchCredentials()).resolves.toEqual(response);
  expect(fake.invoke).toHaveBeenCalledExactlyOnceWith("zpi:call", "getWebSearchCredentials", []);
});

test.each(["web-ipc-fake-key", ""])(
  "returns only explicit saved credentials without side effects: %s",
  async (apiKey) => {
    fake.settings.getWebSearchCredentials.mockReturnValueOnce({ apiKey });
    await expect(call(authorized, "getWebSearchCredentials", [])).resolves.toEqual({
      ok: true,
      value: { apiKey },
    });
    expect(fake.settings.getWebSearchCredentials).toHaveBeenCalledExactlyOnceWith();
    expect(fake.settings.getProviderCredentials).not.toHaveBeenCalled();
    expect(fake.settings.get).not.toHaveBeenCalled();
    expect(fake.window.webContents.send).not.toHaveBeenCalled();
    expect(fake.writeError).not.toHaveBeenCalled();
    expect(fake.fetch).not.toHaveBeenCalled();
  },
);

test.each([
  { sender: {}, senderFrame: fake.window.webContents.mainFrame },
  { sender: fake.window.webContents, senderFrame: {} },
  { sender: fake.window.webContents, senderFrame: null },
])("rejects non-owner windows and child frames before accessing credentials", async (event) => {
  await expect(call(event, "getWebSearchCredentials", [])).resolves.toEqual({
    ok: false,
    error: { code: "invalid_input", message: "invalid_input: 未授权的 IPC sender" },
  });
  expect(fake.settings.getWebSearchCredentials).not.toHaveBeenCalled();
  expect(fake.fetch).not.toHaveBeenCalled();
});

test.each([
  { args: ["unexpected-fake-key"], message: "invalid_input: 参数数量无效" },
  { args: [{ apiKey: "unexpected-fake-key" }], message: "invalid_input: 参数数量无效" },
  { args: null, message: "invalid_input: 未知 IPC 方法" },
])("rejects arguments without logging their contents: %j", async ({ args, message }) => {
  await expect(call(authorized, "getWebSearchCredentials", args)).resolves.toEqual({
    ok: false,
    error: { code: "invalid_input", message },
  });
  expect(fake.settings.getWebSearchCredentials).not.toHaveBeenCalled();
  expect(JSON.stringify(fake.writeError.mock.calls)).not.toContain("unexpected-fake-key");
  expect(fake.writeError.mock.calls.map((args) => args.map(String).join(" ")).join(" ")).not.toContain(
    "unexpected-fake-key",
  );
  expect(fake.fetch).not.toHaveBeenCalled();
});

test("keeps the execution credential getter outside the public IPC allowlist", async () => {
  expect(methods).not.toContain("getWebSearchApiKey");
  await expect(call(authorized, "getWebSearchApiKey", [])).resolves.toEqual({
    ok: false,
    error: { code: "invalid_input", message: "invalid_input: 未知 IPC 方法" },
  });
  expect(fake.settings.getWebSearchCredentials).not.toHaveBeenCalled();
});

test("returns a controlled locked error without credentials, broadcasts or network access", async () => {
  const message = "configuration: 保存的联网搜索凭据尚未解锁";
  fake.settings.getWebSearchCredentials.mockImplementationOnce(() => {
    throw new Error(message);
  });
  await expect(call(authorized, "getWebSearchCredentials", [])).resolves.toEqual({
    ok: false,
    error: { code: "configuration", message },
  });
  expect(fake.writeError).toHaveBeenCalledExactlyOnceWith("ipc", new Error(message), {
    method: "getWebSearchCredentials",
  });
  expect(fake.window.webContents.send).not.toHaveBeenCalled();
  expect(fake.fetch).not.toHaveBeenCalled();
});

test("the temporary window channel cannot reveal credentials or accept the main renderer", async () => {
  for (const method of ["getSnapshot", "getWebSearchCredentials", "getProviderCredentials"]) {
    expect(await quickCall(authorized, method, [])).toMatchObject({
      ok: false,
      error: { code: "invalid_input" },
    });
  }
  expect(fake.settings.getWebSearchCredentials).not.toHaveBeenCalled();
  expect(fake.settings.getProviderCredentials).not.toHaveBeenCalled();
});

test("saves quick-chat defaults only through the main bridge and allowlisted one-argument method", async () => {
  const input = { defaultSelection: { provider: "chat", modelId: "model", reasoning: "none" } };
  const settings = { ...fake.settings.get(), quickChat: input };
  fake.invoke.mockResolvedValueOnce({ ok: true, value: settings });
  await expect(bridge.saveQuickChatSettings(input)).resolves.toEqual({ ok: true, value: settings });
  expect(fake.invoke).toHaveBeenCalledExactlyOnceWith("zpi:call", "saveQuickChatSettings", [input]);
  expect(methods).toContain("saveQuickChatSettings");
  fake.settings.saveQuickChatSettings.mockReturnValueOnce(settings);
  await expect(call(authorized, "saveQuickChatSettings", [input])).resolves.toEqual({
    ok: true,
    value: settings,
  });
  expect(fake.settings.saveQuickChatSettings).toHaveBeenCalledExactlyOnceWith(input);
});

test.each([
  { sender: {}, senderFrame: fake.window.webContents.mainFrame },
  { sender: fake.window.webContents, senderFrame: {} },
  { sender: fake.window.webContents, senderFrame: null },
])("rejects non-owner windows and child frames before saving quick-chat defaults", async (event) => {
  await expect(call(event, "saveQuickChatSettings", [{ defaultSelection: null }])).resolves.toMatchObject({
    ok: false,
    error: { code: "invalid_input", message: "invalid_input: 未授权的 IPC sender" },
  });
  expect(fake.settings.saveQuickChatSettings).not.toHaveBeenCalled();
});

test.each([
  { args: [] },
  { args: [null] },
  { args: [[]] },
  { args: [{ defaultSelection: null, extra: true }] },
  { args: [{ defaultSelection: null }, "extra"] },
])("rejects invalid default-settings IPC arguments: %j", async ({ args }) => {
  await expect(call(authorized, "saveQuickChatSettings", args)).resolves.toMatchObject({
    ok: false,
    error: { code: "invalid_input" },
  });
  expect(fake.settings.saveQuickChatSettings).not.toHaveBeenCalled();
});

test("the temporary channel cannot save quick-chat defaults", async () => {
  expect(await quickCall(authorized, "saveQuickChatSettings", [{ defaultSelection: null }])).toMatchObject({
    ok: false,
    error: { code: "invalid_input" },
  });
  expect(fake.settings.saveQuickChatSettings).not.toHaveBeenCalled();
});
