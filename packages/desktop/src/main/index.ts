import { stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  app,
  type BrowserWindow,
  clipboard,
  dialog,
  globalShortcut,
  ipcMain,
  Menu,
  nativeTheme,
  net,
  safeStorage,
  screen,
  shell,
  systemPreferences,
} from "electron";
import { fetchProviderModels, getProviderPreset, type ModelDiscoveryInput, usesChatGPTAuth } from "zpi-ai";
import { listCommands } from "zpi-coding-agent";
import { userErrorMessage } from "zpi-ui/errors";
import { version } from "../../../../package.json";
import type {
  CombinedSelection,
  ErrorCode,
  InterfacePreferences,
  ProviderInput,
  Result,
  RunInput,
} from "../shared/bridge.ts";
import { methods } from "../shared/bridge.ts";
import type { ShortcutSettings } from "../shared/shortcuts.ts";
import { createDesktopWindow, hiddenTestMode, testMode } from "./automation.ts";
import { browserUrl } from "./browser-url.ts";
import { ChatGPTAuth } from "./chatgpt-auth.ts";
import { defaultFileOpener } from "./default-file-open.ts";
import { getInstalledEditors, openInEditor } from "./editors.ts";
import { ErrorLog } from "./error-log.ts";
import { performFileAction } from "./file-actions.ts";
import { readFilePreview, readPreviewRange } from "./file-preview.ts";
import { loadRenderer } from "./load-renderer.ts";
import { macQuickChatCapture } from "./mac-quick-chat-capture.ts";
import { macQuickChatFocus } from "./mac-quick-chat-focus.ts";
import { PaneServices } from "./pane-services.ts";
import { checkPreviewFiles } from "./preview-files.ts";
import { PreviewPdfExporter, previewPdfOptions } from "./preview-pdf-export.ts";
import { previewPrintHostScript, previewPrintIsolationCss } from "./preview-print-host.ts";
import { openProjectFromDialog } from "./project-picker.ts";
import { QuickChatCapture } from "./quick-chat-capture.ts";
import { QuickChatHost } from "./quick-chat-host.ts";
import { QuickChatTiming } from "./quick-chat-timing.ts";
import { installQuickChatIpc, QuickChatWindow } from "./quick-chat-window.ts";
import { SessionHost } from "./session-host.ts";
import { shellEnvironment } from "./shell-environment.ts";
import {
  forwardBrowserShortcut,
  ShortcutController,
  setWindowMenuShortcutsIgnored,
  toggleShortcutWindow,
} from "./shortcut-controller.ts";
import { ShortcutModifier } from "./shortcut-modifier.ts";
import { StateStore } from "./state-store.ts";
import { SettingsStore } from "./storage.ts";
import { openStorageGeneration } from "./storage-generation.ts";
import { TaskNotifications } from "./task-notifications.ts";
import { WebSourceIcons } from "./web-source-icons.ts";

const webSourceIcons = new WebSourceIcons();
const dir = fileURLToPath(new URL(".", import.meta.url));
const openFile = defaultFileOpener(
  (path) => shell.openPath(path),
  async (path) => (await app.getApplicationInfoForProtocol(pathToFileURL(path).href)).path,
);
// Match ZCode's Chromium locale: on macOS zh-CN changes system-ui's Chinese
// fallback from PingFang UI Display to PingFang SC, enlarging every UI label.
// UI copy is supplied by React and remains Chinese.
if (process.platform === "darwin") app.commandLine.appendSwitch("lang", "en-US");
const requestFetch: typeof fetch = (input, init) =>
  net.fetch(input instanceof URL ? input.href : input, { ...init, credentials: "omit" });
let ending = false;
// 与渲染端 --color-window-bg / --color-tooltip-foreground 保持一致的窗口按钮配色。
function titleBarOverlay(): Electron.TitleBarOverlayOptions {
  const dark = nativeTheme.shouldUseDarkColors;
  return {
    color: dark ? "#2b2b2b" : "#ececee",
    symbolColor: dark ? "#f8f8f8" : "#0d0d0d",
    height: 48,
  };
}
// Development shares Preview's data and Keychain identity; production remains separate.
const dataName = app.isPackaged ? app.getName() : "ZPI Preview";
app.setName(dataName);
app.setPath("userData", join(app.getPath("appData"), dataName));
const dataOverride = (testMode && process.env.ZPI_TEST_DATA_DIR) || process.env.ZPI_DATA_DIR;
if (dataOverride) {
  if (!isAbsolute(dataOverride)) throw new Error("storage: ZPI_DATA_DIR/ZPI_TEST_DATA_DIR must be absolute");
  app.setPath("userData", dataOverride);
}
const errors = new ErrorLog(app.getPath("userData"), {
  version: app.isPackaged ? app.getVersion() : version,
  electron: process.versions.electron,
});
process.on("uncaughtExceptionMonitor", (error, origin) =>
  errors.write(origin === "unhandledRejection" ? "main.unhandled-rejection" : "main.uncaught", error),
);
// Electron warns about unhandled rejections without routing them through the exception monitor.
process.on("unhandledRejection", (error) => {
  errors.write("main.unhandled-rejection", error);
  console.error("Unhandled promise rejection:", error);
});
app.on("web-contents-created", (_event, contents) => {
  contents.on("preload-error", (_event, _path, error) => errors.write("preload", error));
  contents.on("render-process-gone", (_event, details) => {
    if (!ending && details.reason !== "clean-exit")
      errors.write("renderer.process-gone", details.reason, {
        webContentsId: contents.id,
        exitCode: details.exitCode,
      });
  });
});
app.on("child-process-gone", (_event, details) => {
  if (!ending && details.reason !== "clean-exit")
    errors.write("main.child-process-gone", details.reason, {
      type: details.type,
      exitCode: details.exitCode,
    });
});
if (!app.requestSingleInstanceLock()) app.quit();
else
  void launch().catch((error) => {
    errors.write("main.startup", error);
    if (!ending) {
      if (testMode) console.error("ZPI 启动失败", error);
      else dialog.showErrorBox("ZPI 启动失败", error instanceof Error ? error.message : String(error));
    }
    app.quit();
  });
async function launch(): Promise<void> {
  await app.whenReady();
  if (!testMode) Object.assign(process.env, await shellEnvironment());
  const icon = app.isPackaged
    ? join(process.resourcesPath, "icon.png")
    : process.platform === "darwin"
      ? join(dir, "../icon-mac.png")
      : resolve("icon.png");
  app.dock?.setIcon(icon);
  const encryption = testMode
    ? { isEncryptionAvailable: () => false, encryptString: () => Buffer.alloc(0), decryptString: () => "" }
    : safeStorage;
  const storage = openStorageGeneration(app.getPath("userData"), (directory) => {
    const initial = new StateStore(join(directory, "state.sqlite"));
    initial.close();
  });
  let state: StateStore;
  try {
    state = new StateStore(join(storage.directory, "state.sqlite"));
  } catch (error) {
    storage.close();
    throw error;
  }
  let storageClosed = false;
  const closeStorage = () => {
    if (storageClosed) return;
    state.close();
    storage.close();
    storageClosed = true;
  };
  app.once("will-quit", () => {
    try {
      closeStorage();
    } catch (error) {
      errors.write("storage.close", error);
    }
  });
  const settings = new SettingsStore(storage.directory, encryption, state);
  nativeTheme.themeSource = settings.get().interface.theme;
  let discovered: string[] = [];
  if (!testMode) {
    try {
      discovered = settings.discoverEnvironment(process.env);
    } catch (error) {
      errors.write("settings.discovery", error);
    }
  }
  const chatgptAuth = new ChatGPTAuth(settings, requestFetch, errors);
  if (testMode && process.env.ZPI_TEST_BASE_URL && settings.get().providers.length === 0)
    settings.save({
      baseUrl: process.env.ZPI_TEST_BASE_URL,
      modelId: "fake",
      apiKey: "local-test-key",
      supportsImages: false,
      reasoning: true,
      contextWindow: 32768,
      maxTokens: 4096,
      compat: { supportsReasoningEffort: true },
    });
  if (testMode && process.env.ZPI_TEST_AUTO_SELECTION === "1") {
    if (!settings.get().lastSelection)
      settings.rememberSelection({ provider: "custom", modelId: "fake", reasoning: "none" });
    settings.updatePreferences({ showSendButton: true, showContextUsage: true });
  }
  const host = new SessionHost(
    storage.directory,
    settings,
    testMode ? app.getPath("userData") : homedir(),
    testMode ? join(app.getPath("userData"), "workspace") : join(homedir(), "Documents", "ZPI"),
    requestFetch,
    errors,
    testMode ? join(app.getPath("userData"), "worktree") : undefined,
  );
  await host.init();
  const display = screen.getPrimaryDisplay().workAreaSize;
  // 非 macOS 的默认菜单直接显示在窗口顶栏，与 ZCode 的无菜单界面不符，整体移除。
  if (testMode || process.platform !== "darwin") Menu.setApplicationMenu(null);
  // Match ZCode's inset panels to the native window corners (Tahoe uses larger corners).
  const workspacePanelRadius =
    process.platform === "win32"
      ? 5
      : process.platform === "darwin" && Number.parseInt(process.getSystemVersion?.() ?? "", 10) < 26
        ? 6
        : 12;
  const window = createDesktopWindow({
    width: Math.min(1200, display.width),
    height: Math.min(800, display.height),
    minWidth: 740,
    minHeight: 560,
    title: dataName,
    backgroundColor: "#f8f8f8",
    icon,
    // 与 ZCode 的 macOS 顶栏一致：隐藏原生标题栏，让窗口控件与侧栏开关位于同一排。
    // Windows 由系统绘制右上角的最小化/最大化/关闭按钮，配色跟随主题。
    titleBarStyle: process.platform === "linux" ? "default" : "hidden",
    ...(process.platform === "win32" ? { titleBarOverlay: titleBarOverlay() } : {}),
    ...(process.platform === "darwin"
      ? {
          backgroundColor: "#00000000",
          trafficLightPosition: { x: 22, y: 23 },
          vibrancy: "under-window",
          visualEffectState: "active",
        }
      : {}),
    webPreferences: {
      additionalArguments: [`--zpi-panel-radius=${workspacePanelRadius}`],
      preload: join(dir, "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });
  window.webContents.on("console-message", (details) => {
    if (details.level === "error")
      errors.write("renderer.console", details.message, { file: details.sourceId, line: details.lineNumber });
  });
  if (process.platform === "win32")
    nativeTheme.on("updated", () => {
      if (!window.isDestroyed()) window.setTitleBarOverlay(titleBarOverlay());
    });
  ipcMain.on("zpi:error", (event, error: unknown) => {
    if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) return;
    if (!error || typeof error !== "object") return;
    const details = error as { source?: unknown; message?: unknown; stack?: unknown };
    if (
      typeof details.source !== "string" ||
      details.source.length > 120 ||
      typeof details.message !== "string" ||
      details.message.length > 32_000 ||
      (details.stack !== undefined && (typeof details.stack !== "string" || details.stack.length > 32_000))
    )
      return;
    errors.write(`renderer.${details.source}`, { message: details.message, stack: details.stack });
  });
  const settingsReady = new Promise<void>((resolveReady) =>
    window.webContents.once("did-finish-load", () => resolveReady()),
  );
  for (const id of discovered) {
    const original = settings.snapshot(id);
    void fetchProviderModels(
      { preset: original.preset, api: original.api, apiKey: original.apiKey },
      requestFetch,
    )
      .then(async (result) => {
        if (result.source !== "remote" || ending) return;
        if (!settings.get().providers.some((provider) => provider.id === id)) return;
        const current = settings.snapshot(id);
        if (JSON.stringify(current) !== JSON.stringify(original)) return;
        settings.saveProvider({
          ...original,
          models: result.models.map((model) => ({ ...model, useRecommendedConfig: true })),
        });
        await settingsReady;
        quickChatHost.refreshSettings();
        if (!window.isDestroyed()) window.webContents.send("zpi:settings", settings.get());
      })
      .catch((error) => {
        errors.write("models.discovery", error, { providerId: id });
        /* Keep the usable catalog; settings offers explicit retry. */
      });
  }
  const rendererUrl = process.env.ZPI_DEV_URL ?? pathToFileURL(join(dir, "../renderer/index.html")).href;
  const quickChatHost = new QuickChatHost(
    settings,
    testMode ? join(app.getPath("userData"), "workspace") : join(homedir(), "Documents", "ZPI"),
    requestFetch,
  );
  const quickChatTiming =
    process.env.ZPI_QUICK_CHAT_TIMING === "1"
      ? new QuickChatTiming(app.getPath("userData"), true)
      : undefined;
  const quickChat = new QuickChatWindow({
    host: quickChatHost,
    onError: (error, method) => errors.write("quick-chat.ipc", error, { method }),
    timing: quickChatTiming,
    createWindow: createDesktopWindow,
    rendererUrl: new URL("quick-chat.html", rendererUrl).href,
    preload: join(dir, "../preload/quick-chat.cjs"),
    hiddenTestMode,
    platform: process.platform,
    getDisplay: (bounds) =>
      bounds
        ? screen.getDisplayMatching(bounds)
        : screen.getDisplayNearestPoint(screen.getCursorScreenPoint()),
    loadSourceIcon: (url, signal) => webSourceIcons.load(url, signal),
    ...(process.platform === "darwin" ? { workspaceNotifications: systemPreferences } : {}),
    copyText: (text) => clipboard.writeText(text),
    activateApp:
      process.platform === "darwin" && !hiddenTestMode
        ? macQuickChatFocus(join(dir, "../native"))
        : undefined,
    openExternal: (url) => shell.openExternal(url),
  });
  const removeQuickChatIpc = installQuickChatIpc(ipcMain, quickChat);
  const quickChatCapture = new QuickChatCapture({
    sessionId: () => quickChatHost.sessionId,
    hide: () => quickChat.hide(),
    open: (input, sessionId) => quickChat.openWithDraft(input, sessionId),
    read: macQuickChatCapture({
      platform: process.platform,
      testMode,
      temporaryDirectory: app.getPath("temp"),
      copyHelper: join(dir, "../native/copy-selection").replace(/\.asar([/\\])/, ".asar.unpacked$1"),
      clipboard,
      accessibilityAccess: () => systemPreferences.isTrustedAccessibilityClient(true),
    }),
  });
  const shortcuts = new ShortcutController(
    globalShortcut,
    process.platform,
    (command) => {
      if (ending) return;
      if (
        command === "quick-chat-screenshot" ||
        command === "quick-chat-selection" ||
        command === "quick-chat-clipboard"
      ) {
        const kind =
          command === "quick-chat-screenshot"
            ? "screenshot"
            : command === "quick-chat-selection"
              ? "selection"
              : "clipboard";
        const sessionId = quickChatHost.sessionId;
        void quickChatCapture.invoke(kind).catch((error) => {
          if (ending) return;
          errors.write("quick-chat.capture", error);
          void quickChat
            .openWithDraft({ error: userErrorMessage(error) }, sessionId)
            .catch((reason) => errors.write("quick-chat.capture-notice", reason));
        });
        return;
      }
      if (command === "quick-chat" || command === "quick-chat-new") {
        const action = quickChat.toggle(command === "quick-chat-new");
        void action.catch((error) => {
          errors.write("quick-chat.window", error);
          if (!testMode && !ending) dialog.showErrorBox("快速对话无法打开", String(error));
        });
        return;
      }
      if (hiddenTestMode || !toggleShortcutWindow(window)) return;
      // Native guests and DOM controls normally retain focus; notify only for a lost-target fallback.
      if (!window.webContents.isDestroyed() && !panes.hasFocusedBrowser())
        window.webContents.send("zpi:shortcut", "toggle-window");
    },
    testMode,
    (ignore) => setWindowMenuShortcutsIgnored(window, ignore),
    quickChatTiming ? quickChat.recordShortcut : undefined,
  );
  let shortcutSettings = settings.get().shortcuts;
  const shortcutModifier = new ShortcutModifier(
    process.platform,
    () => !ending && shortcutSettings.enabled && !shortcuts.isCapturing,
    (held) => {
      if (!window.isDestroyed() && !window.webContents.isDestroyed())
        window.webContents.send("zpi:shortcut-modifier", held);
    },
  );
  shortcutModifier.observe(window.webContents, true);
  window.on("blur", shortcutModifier.reset);
  window.on("hide", shortcutModifier.reset);
  window.on("minimize", shortcutModifier.reset);
  window.on("closed", () => shortcutModifier.dispose());
  let shortcutStartupError: Error | undefined;
  try {
    shortcuts.initialize(shortcutSettings);
  } catch (error) {
    shortcutStartupError = error instanceof Error ? error : new Error(String(error));
    errors.write("shortcuts.registration", error);
  }
  // A reload/crash must never leave recording mode active indefinitely.
  const resetShortcutCapture = () => {
    if (!shortcuts.isCapturing) return;
    try {
      shortcuts.setCapture(false);
    } catch (error) {
      errors.write("shortcuts.capture-reset", error);
      if (!testMode && !ending && !window.isDestroyed())
        void dialog.showMessageBox(window, {
          type: "warning",
          title: "全局快捷键不可用",
          message: String(error),
          detail: "录制已结束，但无法恢复全局快捷键。请在快捷键设置中更换组合并保存。",
        });
    }
  };
  window.on("blur", resetShortcutCapture);
  window.webContents.on("did-start-loading", resetShortcutCapture);
  window.webContents.on("render-process-gone", resetShortcutCapture);
  const panes = new PaneServices(
    window,
    (event) => {
      if (!window.isDestroyed()) window.webContents.send("zpi:pane-event", event);
    },
    (event) => {
      if (ending || shortcuts.isCapturing || window.isDestroyed() || window.webContents.isDestroyed())
        return false;
      return forwardBrowserShortcut(
        event,
        process.platform,
        shortcutSettings,
        (command) => window.webContents.send("zpi:shortcut", command),
        () => window.webContents.focus(),
      );
    },
    shortcutModifier,
  );
  window.webContents.on("did-start-navigation", (details) => {
    if (details.isMainFrame && !details.isSameDocument) panes.reset();
  });
  window.webContents.on("render-process-gone", () => panes.reset());
  window.on("closed", () => panes.close());
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (e) => e.preventDefault());
  window.webContents.on("will-redirect", (e) => e.preventDefault());
  window.webContents.session.setPermissionRequestHandler((_, __, cb) => cb(false));
  window.webContents.session.setPermissionCheckHandler(() => false);
  const pdfExporter = new PreviewPdfExporter({
    ready: (sessionId) => window.webContents.executeJavaScript(previewPrintHostScript(sessionId)),
    print: async () => {
      const key = await window.webContents.insertCSS(previewPrintIsolationCss, { cssOrigin: "user" });
      try {
        return await window.webContents.printToPDF(previewPdfOptions);
      } finally {
        await window.webContents.removeInsertedCSS(key);
      }
    },
    chooseFile: (suggestedName) =>
      dialog.showSaveDialog(window, {
        title: "导出 PDF",
        defaultPath: suggestedName,
        filters: [{ name: "PDF", extensions: ["pdf"] }],
      }),
    write: (path, data) => writeFile(path, data),
  });
  const notifications = new TaskNotifications(window, () => settings.get().interface);
  host.subscribe((event) => {
    if (!window.isDestroyed()) window.webContents.send("zpi:event", event);
    if (!ending && event.event.type === "settled") {
      const record = host.listRecentSessions().find((record) => record.id === event.sessionId);
      if (record) notifications.handle(event, record.title);
    }
  });
  ipcMain.handle("zpi:call", async (event, method: unknown, args: unknown): Promise<Result<unknown>> => {
    try {
      if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame)
        throw new Error("invalid_input: 未授权的 IPC sender");
      if (
        typeof method !== "string" ||
        !(methods as readonly string[]).includes(method) ||
        !Array.isArray(args)
      )
        throw new Error("invalid_input: 未知 IPC 方法");
      const string = (i: number) => {
        const value = args[i];
        if (typeof value !== "string") throw new Error("invalid_input: 参数必须是字符串");
        return value;
      };
      const object = (i: number, keys: string[]): Record<string, unknown> => {
        const value = args[i];
        if (
          !value ||
          typeof value !== "object" ||
          Array.isArray(value) ||
          Object.keys(value).some((k) => !keys.includes(k))
        )
          throw new Error("invalid_input: 参数对象无效");
        return value;
      };
      const count: Record<(typeof methods)[number], number> = {
        openQuickChat: 0,
        setSessionUnread: 1,
        getTaskGroups: 0,
        updateTaskGroups: 1,
        listSubagents: 1,
        saveSubagent: 1,
        deleteSubagent: 2,
        setSubagentEnabled: 3,
        stopSubagent: 2,
        stopBackgroundTask: 2,
        readBackgroundTask: 2,
        setCapabilityEnabled: 2,
        respondToQuestion: 3,
        snoozeQuestion: 2,
        createSideChat: 1,
        closeSideChat: 1,
        getGitEnvironment: 1,
        setNewWorktree: 3,
        activateSession: 1,
        archiveSession: 1,
        listArchivedSessions: 0,
        restoreSession: 1,
        openDirectory: 1,
        createTerminal: 1,
        terminalInput: 2,
        resizeTerminal: 3,
        closeTerminal: 1,
        createBrowser: 1,
        browserAction: 3,
        browserBounds: 2,
        closeBrowser: 1,
        getDraft: 1,
        saveDraft: 2,
        getHistoryPage: 2,
        copyText: 1,
        copySessionPath: 1,
        fileAction: 4,
        getInstalledEditors: 0,
        printPageToPdf: 1,
        savePreviewPdf: 2,
        openInEditor: 3,
        searchFiles: 2,
        getWorkspaceInfo: 1,
        readFilePreview: 3,
        readPreviewRange: 4,
        checkPreviewFiles: 2,
        downloadImage: 1,
        readWebSourceIcon: 3,
        pickAttachments: 1,
        importAttachment: 2,
        readAttachment: 2,
        removeAttachment: 2,
        getChanges: 3,
        readPatch: 3,
        previewPrompt: 0,
        listTools: 0,
        getCustomCommands: 1,
        listSessionCustomCommands: 1,
        createCustomCommand: 2,
        updateCustomCommand: 2,
        deleteCustomCommand: 2,
        setCustomCommandEnabled: 2,
        discoverCommandImports: 1,
        importCommands: 2,
        getSkillSettings: 0,
        readSkill: 1,
        setSkillEnabled: 2,
        listProjects: 0,
        addProject: 1,
        removeProject: 1,
        listSessions: 1,
        listRecentSessions: 0,
        searchTasks: 2,
        getTaskSearchChanges: 1,
        listTaskFiles: 1,
        listSessionMentions: 1,
        setSessionPinned: 2,
        getProviderCredentials: 1,
        getWebSearchCredentials: 0,
        updatePreferences: 1,
        setSessionSelection: 2,
        listSessionSkills: 1,
        createSession: 2,
        getSessionSnapshot: 1,
        renameSession: 2,
        deleteSession: 1,
        startRun: 1,
        submitInput: 1,
        editQueuedInput: 2,
        removeQueuedInput: 2,
        sendQueuedNow: 2,
        moveQueuedInput: 3,
        resumeInputQueue: 1,
        forkSession: 2,
        editUserMessage: 3,
        abortRun: 1,
        getSettings: 0,
        updateShortcuts: 1,
        setShortcutCapture: 1,
        beginChatGPTLogin: 1,
        completeChatGPTLogin: 1,
        submitChatGPTCallback: 2,
        cancelChatGPTLogin: 1,
        disconnectChatGPT: 1,
        openExternal: 1,
        saveProvider: 1,
        saveWebSearch: 1,
        saveQuickChatSettings: 1,
        reorderProviders: 1,
        discoverModels: 1,
        deleteProvider: 1,
        listCommands: 0,
      };
      if (args.length !== count[method as (typeof methods)[number]])
        throw new Error("invalid_input: 参数数量无效");
      const sessionContext = () => (args[0] === null ? null : string(0));
      let value: unknown;
      switch (method) {
        case "openQuickChat":
          if (ending) throw new Error("busy: 应用正在退出");
          await quickChat.show();
          break;
        case "listSubagents":
          value = host.listSubagents(sessionContext());
          break;
        case "saveSubagent":
          value = host.saveSubagent(
            object(0, [
              "id",
              "config",
              "scope",
              "sessionId",
            ]) as unknown as import("../shared/subagents.ts").SaveSubagentInput,
          );
          break;
        case "deleteSubagent":
          value = host.subagents.profiles.delete(
            string(0),
            args[1] === null ? undefined : host.workspaceInfo(string(1)).cwd,
          );
          break;
        case "setSubagentEnabled":
          value = host.subagents.profiles.enable(
            string(0),
            args[1] as boolean,
            args[2] === null ? undefined : host.workspaceInfo(string(2)).cwd,
          );
          break;
        case "stopSubagent":
          await host.subagents.stop(string(0), string(1));
          break;
        case "stopBackgroundTask":
          await host.backgroundTasks.stop(string(0), string(1));
          break;
        case "readBackgroundTask":
          value = await host.backgroundTasks.read(string(0), string(1));
          break;
        case "setCapabilityEnabled":
          value = settings.setCapabilityEnabled(
            string(0) as import("../shared/bridge.ts").CapabilityName,
            args[1] as boolean,
          );
          break;
        case "respondToQuestion":
          host.questions.respond(
            string(0),
            string(1),
            object(2, ["answers", "annotations"]) as unknown as import("zpi-ui").UserQuestionResponse,
          );
          break;
        case "snoozeQuestion":
          host.questions.snooze(string(0), string(1));
          break;
        case "closeSideChat":
          await host.closeSideChat(string(0));
          break;
        case "createSideChat":
          value = await host.createSideChat(string(0));
          break;
        case "getGitEnvironment":
          value = await host.getGitEnvironment(string(0));
          break;
        case "setNewWorktree":
          value = await host.setNewWorktree(string(0), args[1] as boolean, args[2] as string | undefined);
          break;
        case "archiveSession":
          await host.archiveSession(string(0));
          break;
        case "listArchivedSessions":
          value = host.listArchivedSessions();
          break;
        case "restoreSession":
          value = host.restoreSession(string(0));
          break;
        case "openDirectory": {
          const path = string(0);
          if (!isAbsolute(path) || !(await stat(path)).isDirectory())
            throw new Error("invalid_input: 请选目录");
          const failure = await shell.openPath(path);
          if (failure) throw new Error(`storage: ${failure}`);
          break;
        }
        case "createTerminal":
          value = await panes.createTerminal(host.workspaceInfo(string(0)).cwd);
          break;
        case "terminalInput":
          panes.terminalInput(string(0), string(1));
          break;
        case "resizeTerminal":
          panes.resizeTerminal(string(0), args[1] as number, args[2] as number);
          break;
        case "closeTerminal":
          panes.closeTerminal(string(0));
          break;
        case "createBrowser":
          value = panes.createBrowser(string(0));
          break;
        case "browserAction":
          panes.action(string(0), string(1), args[2] === undefined ? undefined : string(2));
          break;
        case "browserBounds":
          panes.bounds(
            string(0),
            args[1] === null
              ? null
              : (object(1, [
                  "x",
                  "y",
                  "width",
                  "height",
                ]) as unknown as import("../shared/bridge.ts").PaneBounds),
          );
          break;
        case "closeBrowser":
          panes.closeBrowser(string(0));
          break;
        case "getDraft":
          value = await host.getDraft(string(0));
          break;
        case "saveDraft":
          host.saveDraft(
            string(0),
            object(1, [
              "text",
              "fileReferences",
              "selection",
              "selections",
              "revision",
            ]) as unknown as import("../shared/bridge.ts").TextDraft,
          );
          break;
        case "getHistoryPage":
          if (typeof args[1] !== "number") throw new Error("invalid_input: 历史游标必须为数字");
          value = host.getHistoryPage(string(0), args[1]);
          break;
        case "copySessionPath":
          clipboard.writeText(host.sessionPath(string(0)));
          break;
        case "copyText": {
          const text = string(0);
          if (Buffer.byteLength(text, "utf8") > 2 * 1024 * 1024)
            throw new Error("invalid_input: 复制内容超过 2 MiB");
          clipboard.writeText(text);
          break;
        }
        case "printPageToPdf":
          host.workspaceInfo(string(0));
          value = await pdfExporter.print(string(0));
          break;
        case "savePreviewPdf":
          value = await pdfExporter.save(args[0], string(1));
          break;
        case "getInstalledEditors":
          value = await getInstalledEditors();
          break;
        case "openInEditor":
          await openInEditor(host.workspaceInfo(string(0)).cwd, string(1), string(2));
          break;
        case "fileAction":
          await performFileAction(
            host.workspaceInfo(string(0)).cwd,
            string(1),
            string(2),
            {
              openPath: openFile,
              showItemInFolder: (path) => shell.showItemInFolder(path),
              writeText: (text) => clipboard.writeText(text),
            },
            args[3],
          );
          break;
        case "readWebSourceIcon": {
          const icon = host.recordedWebSourceIcon(string(0), string(1), string(2));
          const dataUrl = icon ? await webSourceIcons.load(icon) : undefined;
          value = dataUrl ? { dataUrl } : {};
          break;
        }
        case "downloadImage": {
          const src = string(0);
          if (
            src.length > 48 * 1024 * 1024 ||
            (!/^https?:/i.test(src) &&
              !/^data:image\/(?:png|jpeg|gif|webp|svg\+xml|bmp|avif);base64,/i.test(src))
          )
            throw new Error("invalid_input: 图片下载地址无效");
          if (/^https?:/i.test(src)) new URL(src);
          window.webContents.downloadURL(src);
          break;
        }
        case "searchFiles":
          value = await host.searchFiles(string(0), string(1));
          break;
        case "getWorkspaceInfo":
          value = host.workspaceInfo(sessionContext());
          break;
        case "checkPreviewFiles":
          value = await checkPreviewFiles(host.workspaceInfo(string(0)).cwd, args[1]);
          break;
        case "readPreviewRange":
          value = await readPreviewRange(host.workspaceInfo(string(0)).cwd, string(1), args[2], args[3]);
          break;
        case "readFilePreview":
          value = await readFilePreview(host.workspaceInfo(string(0)).cwd, string(1), args[2]);
          break;
        case "importAttachment": {
          const id = string(0);
          if (typeof args[1] === "string") value = await host.importFile(id, string(1));
          else {
            const file = object(1, ["name", "bytes"]);
            if (typeof file.name !== "string" || !(file.bytes instanceof Uint8Array))
              throw new Error("invalid_input: 附件参数无效");
            value = await host.importAttachment(id, file.name, file.bytes);
          }
          break;
        }
        case "pickAttachments": {
          const id = string(0);
          host.workspaceInfo(id);
          const paths = testMode
            ? (JSON.parse(
                process.env.ZPI_TEST_ATTACHMENT_FILES ?? process.env.ZPI_TEST_IMAGE_FILES ?? "[]",
              ) as string[])
            : (
                await dialog.showOpenDialog(window, {
                  properties: ["openFile", "multiSelections"],
                })
              ).filePaths;
          if (paths.length > 8) throw new Error("invalid_input: 每条消息最多 8 个附件");
          const imported = [];
          try {
            for (const path of paths) {
              imported.push(await host.importFile(id, path));
            }
          } catch (e) {
            for (const item of imported) await host.removeAttachment(id, item.id);
            throw e;
          }
          value = imported;
          break;
        }
        case "readAttachment":
          value = await host.readAttachment(string(0), string(1));
          break;
        case "removeAttachment":
          value = await host.removeAttachment(string(0), string(1));
          break;
        case "getChanges":
          if (typeof args[2] !== "boolean") throw new Error("invalid_input: 参数必须是布尔值");
          value = await host.getChanges(string(0), args[1] === null ? null : string(1), args[2]);
          break;
        case "readPatch":
          value = await host.readPatch(string(0), args[1] === null ? null : string(1), string(2));
          break;
        case "previewPrompt":
          value = await host.previewPrompt();
          break;
        case "listTools":
          value = host.listTools();
          break;
        case "getCustomCommands":
          value = await host.commandServices(args[0] === undefined ? undefined : string(0)).commands.list();
          break;
        case "listSessionCustomCommands":
          value = await host.listSessionCustomCommands(string(0));
          break;
        case "createCustomCommand":
          value = await host
            .commandServices(args[1] === undefined ? undefined : string(1))
            .commands.create(
              object(0, [
                "name",
                "prompt",
                "description",
                "argumentHint",
              ]) as unknown as import("../shared/custom-commands.ts").CustomCommandInput,
            );
          break;
        case "updateCustomCommand":
          value = await host
            .commandServices(args[1] === undefined ? undefined : string(1))
            .commands.update(
              object(0, [
                "id",
                "expectedRevision",
                "name",
                "prompt",
                "description",
                "argumentHint",
                "confirmLinkedSource",
                "expectedSourcePath",
              ]) as unknown as import("../shared/custom-commands.ts").CustomCommandUpdate,
            );
          break;
        case "deleteCustomCommand":
          value = await host
            .commandServices(args[1] === undefined ? undefined : string(1))
            .commands.delete(
              object(0, [
                "id",
                "expectedRevision",
              ]) as unknown as import("../shared/custom-commands.ts").CustomCommandDelete,
            );
          break;
        case "setCustomCommandEnabled":
          value = await host
            .commandServices(args[1] === undefined ? undefined : string(1))
            .commands.setEnabled(
              object(0, [
                "id",
                "enabled",
              ]) as unknown as import("../shared/custom-commands.ts").CustomCommandSetEnabled,
            );
          break;
        case "discoverCommandImports":
          value = await host
            .commandServices(args[0] === undefined ? undefined : string(0))
            .imports.discover();
          break;
        case "importCommands":
          value = await host
            .commandServices(args[1] === undefined ? undefined : string(1))
            .imports.importSelected(
              object(0, [
                "scanId",
                "mode",
                "selections",
              ]) as unknown as import("../shared/command-import.ts").CommandImportRequest,
            );
          break;
        case "getSkillSettings":
          value = await host.getSkillSettings();
          break;
        case "readSkill":
          value = await host.readSkill(string(0));
          break;
        case "setSkillEnabled": {
          if (typeof args[1] !== "boolean") throw new Error("invalid_input: 开关必须为 boolean");
          value = await host.setSkillEnabled(string(0), args[1]);
          break;
        }

        case "listProjects":
          value = host.listProjects();
          break;
        case "addProject": {
          const id = sessionContext();
          value = testMode
            ? process.env.ZPI_TEST_PROJECT_DIR
              ? await host.addProject(process.env.ZPI_TEST_PROJECT_DIR)
              : null
            : await openProjectFromDialog(id, host, (options) => dialog.showOpenDialog(window, options));
          break;
        }
        case "removeProject":
          value = host.removeProject(string(0));
          break;
        case "setSessionUnread":
          host.setSessionUnread(string(0));
          break;
        case "getTaskGroups":
          value = host.getTaskGroups();
          break;
        case "updateTaskGroups":
          value = host.updateTaskGroups(args[0]);
          break;
        case "listSessions":
          value = host.listSessions(string(0));
          break;
        case "getTaskSearchChanges":
          value = await host.getTaskSearchChanges(string(0));
          break;
        case "searchTasks":
          value = host.searchTasks(string(0), args[1] === null ? null : string(1));
          break;
        case "listTaskFiles":
          value = await host.listTaskFiles(sessionContext());
          break;
        case "listRecentSessions":
          value = host.listRecentSessions();
          break;
        case "listSessionMentions":
          value = host.listSessionMentions(string(0));
          break;
        case "setSessionPinned": {
          if (typeof args[1] !== "boolean") throw new Error("invalid_input: 参数必须为布尔值");
          value = host.setSessionPinned(string(0), args[1]);
          break;
        }
        case "activateSession":
          value = host.activateSession(string(0));
          break;
        case "getProviderCredentials":
          value = settings.getProviderCredentials(string(0));
          break;
        case "getWebSearchCredentials":
          value = settings.getWebSearchCredentials();
          break;
        case "updateShortcuts": {
          const updated = shortcuts.update(
            object(0, ["enabled", "bindings"]) as unknown as ShortcutSettings,
            (input) => settings.updateShortcuts(input),
          );
          shortcutSettings = updated.shortcuts;
          shortcutModifier.reset();
          value = updated;
          window.webContents.send("zpi:settings", updated);
          break;
        }
        case "setShortcutCapture":
          shortcutModifier.reset();
          shortcuts.setCapture(args[0] as boolean);
          break;
        case "updatePreferences":
          value = settings.updatePreferences(
            object(0, [
              "theme",
              "fontSize",
              "showContextUsage",
              "showModelPerformance",
              "showSendButton",
              "notificationEnabled",
              "notificationSoundEnabled",
              "sidebarCollapsed",
              "sidebarWidth",
              "collapsedProjectIds",
              "projectsCollapsed",
              "tasksCollapsed",
            ]) as Partial<InterfacePreferences>,
          );
          nativeTheme.themeSource = settings.get().interface.theme;
          break;
        case "setSessionSelection":
          value = await host.setSessionSelection(
            string(0),
            object(1, ["provider", "modelId", "reasoning"]) as unknown as CombinedSelection,
          );
          break;
        case "listSessionSkills":
          value = await host.listSessionSkills(string(0));
          break;
        case "createSession":
          if (args[1] !== undefined && args[1] !== null && typeof args[1] !== "string")
            throw new Error("invalid_input: 无效分组 ID");
          value = host.createSession(args[0] === null ? null : string(0), {
            groupId: args[1] as string | null | undefined,
          });
          break;
        case "getSessionSnapshot":
          value = host.getSessionSnapshot(string(0));
          break;
        case "renameSession":
          value = host.renameSession(string(0), string(1));
          break;
        case "deleteSession":
          value = await host.deleteSession(string(0));
          break;
        case "forkSession":
          value = await host.forkSession(string(0), string(1));
          break;
        case "editUserMessage": {
          const input = object(2, ["text", "fileReferences", "attachments", "workspaceMode"]);
          if (typeof input.text !== "string") throw new Error("invalid_input: 消息参数无效");
          value = await host.editUserMessage(
            string(0),
            string(1),
            input as unknown as import("../shared/bridge.ts").EditUserInput,
          );
          break;
        }
        case "startRun": {
          const o = object(0, ["sessionId", "text", "fileReferences", "attachments"]);
          if (typeof o.sessionId !== "string" || typeof o.text !== "string")
            throw new Error("invalid_input: 消息参数无效");
          value = await host.startRun(o as unknown as RunInput);
          break;
        }
        case "submitInput": {
          const input = object(0, ["sessionId", "text", "fileReferences", "attachments", "queueDisposition"]);
          if (
            typeof input.sessionId !== "string" ||
            typeof input.text !== "string" ||
            (input.queueDisposition !== undefined &&
              input.queueDisposition !== "keep" &&
              input.queueDisposition !== "clear")
          )
            throw new Error("invalid_input: 消息参数无效");
          value = await host.submitInput(
            input as unknown as RunInput,
            input.queueDisposition as "keep" | "clear" | undefined,
          );
          break;
        }
        case "editQueuedInput":
          value = await host.editQueuedInput(string(0), string(1));
          break;
        case "removeQueuedInput":
          host.workspaceInfo(string(0));
          await host.inputQueue.remove(string(0), string(1));
          break;
        case "sendQueuedNow":
          host.workspaceInfo(string(0));
          await host.inputQueue.sendNow(string(0), string(1));
          break;
        case "moveQueuedInput":
          host.workspaceInfo(string(0));
          await host.inputQueue.move(string(0), string(1), args[2] === null ? null : string(2));
          break;
        case "resumeInputQueue":
          host.workspaceInfo(string(0));
          await host.inputQueue.resume(string(0));
          break;
        case "abortRun": {
          const o = object(0, ["sessionId", "runId"]);
          if (typeof o.sessionId !== "string" || typeof o.runId !== "string")
            throw new Error("invalid_input: 取消参数无效");
          value = await host.abortRun({ sessionId: o.sessionId, runId: o.runId });
          break;
        }
        case "getSettings":
          value = settings.get();
          break;
        case "beginChatGPTLogin": {
          const login = await chatgptAuth.begin(args[0] === null ? null : string(0));
          try {
            await shell.openExternal(login.url);
          } catch {
            chatgptAuth.cancel(login.loginId);
            throw new Error("provider: 无法打开浏览器，请重试");
          }
          value = login;
          break;
        }
        case "completeChatGPTLogin":
          value = await chatgptAuth.complete(string(0));
          break;
        case "submitChatGPTCallback":
          chatgptAuth.submit(string(0), string(1));
          break;
        case "cancelChatGPTLogin":
          chatgptAuth.cancel(string(0));
          break;
        case "disconnectChatGPT":
          value = await chatgptAuth.disconnect(string(0));
          break;
        case "discoverModels": {
          const input = object(0, ["preset", "providerId", "baseUrl", "apiKey", "api"]);
          if (Object.values(input).some((value) => typeof value !== "string"))
            throw new Error("invalid_input: 模型发现参数无效");
          const saved =
            typeof input.providerId === "string" ? settings.snapshot(input.providerId) : undefined;
          const preset = input.preset ?? saved?.preset;
          if (preset && (typeof preset !== "string" || !getProviderPreset(preset)))
            throw new Error("invalid_input: 未知厂商");
          value = await fetchProviderModels(
            {
              preset,
              api: input.api ?? saved?.api,
              baseUrl: input.baseUrl ?? saved?.baseUrl,
              apiKey: usesChatGPTAuth(preset as string | undefined)
                ? saved
                  ? await settings.getRequestApiKey(saved.id, requestFetch)
                  : (() => {
                      throw new Error("configuration: 请先登录 ChatGPT");
                    })()
                : (input.apiKey ?? saved?.apiKey ?? ""),
            } as ModelDiscoveryInput,
            requestFetch,
          );
          break;
        }
        case "saveQuickChatSettings":
          value = settings.saveQuickChatSettings(
            object(0, [
              "defaultSelection",
            ]) as unknown as import("../shared/bridge.ts").QuickChatSettingsInput,
          );
          break;
        case "saveWebSearch":
          value = settings.saveWebSearch(
            object(0, [
              "provider",
              "apiKey",
              "enabled",
            ]) as unknown as import("../shared/bridge.ts").WebSearchSettingsInput,
          );
          break;
        case "saveProvider": {
          const input = object(0, ["id", "name", "baseUrl", "models", "apiKey", "preset", "enabled", "api"]);
          if (!usesChatGPTAuth(input.preset as string | undefined) && typeof input.apiKey !== "string")
            throw new Error("invalid_input: 保存时必须提供实际 API key，可为空字符串");
          value = settings.saveProvider(input as unknown as ProviderInput);
          break;
        }
        case "deleteProvider":
          value = settings.deleteProvider(string(0));
          break;
        case "reorderProviders":
          value = settings.reorderProviders(args[0] as string[]);
          break;
        case "listCommands":
          value = listCommands();
          break;
        case "openExternal": {
          const url = new URL(browserUrl(string(0)));
          if (url.protocol === "file:") {
            const failure = await shell.openPath(fileURLToPath(url));
            if (failure) throw new Error(failure);
          } else await shell.openExternal(url.href);
          break;
        }
      }
      if (
        [
          "updateShortcuts",
          "updatePreferences",
          "saveWebSearch",
          "saveQuickChatSettings",
          "saveProvider",
          "deleteProvider",
          "reorderProviders",
          "completeChatGPTLogin",
          "disconnectChatGPT",
          "setCapabilityEnabled",
        ].includes(method)
      )
        quickChatHost.refreshSettings();
      return { ok: true, value };
    } catch (error) {
      errors.write("ipc", error, { method: typeof method === "string" ? method : "unknown" });
      const message = error instanceof Error ? error.message : String(error);
      const codes: ErrorCode[] = [
        "configuration",
        "busy",
        "not_found",
        "provider",
        "storage",
        "invalid_input",
      ];
      const code = codes.find((c) => message.startsWith(`${c}:`)) ?? "storage";
      return { ok: false, error: { code, message } };
    }
  });
  process.on("SIGTERM", () => app.quit());
  process.on("SIGINT", () => app.quit());
  let quitting = false;
  let preparingQuit = false;
  app.on("before-quit", (event) => {
    if (quitting) return;
    event.preventDefault();
    if (preparingQuit) return;
    preparingQuit = true;
    ending = true;
    // On macOS setEnabled(false) creates a visible native overlay even for a hidden window.
    if (!hiddenTestMode && !window.isDestroyed()) window.setEnabled(false);
    void flushDraftsBeforeQuit(window)
      .then(async () => {
        // Drafts are durable now. Finish shutdown even if one service fails;
        // returning to a partially disposed application is not recoverable.
        for (const [scope, close] of [
          ["quick-chat-capture", () => quickChatCapture.dispose()],
          ["quick-chat", () => quickChat.dispose()],
          ["quick-chat-ipc", removeQuickChatIpc],
          ["chatgpt-auth", () => chatgptAuth.close()],
          ["notifications", () => notifications.dispose()],
          ["panes", () => panes.close()],
          ["host", () => host.close()],
        ] as const) {
          try {
            await close();
          } catch (error) {
            errors.write(`main.quit.${scope}`, error);
          }
        }
        quitting = true;
        app.quit();
      })
      .catch((error) => {
        ending = false;
        if (!hiddenTestMode && !window.isDestroyed()) window.setEnabled(true);
        errors.write("drafts.quit", error);
        if (!testMode) dialog.showErrorBox("草稿未保存，已取消退出", String(error));
      })
      .finally(() => {
        preparingQuit = false;
      });
  });
  window.on("close", (event) => {
    if (!quitting) {
      event.preventDefault();
      if (process.platform === "darwin") {
        if (!preparingQuit) window.hide();
      } else app.quit();
    }
  });
  const showWindow = () => {
    if (hiddenTestMode || preparingQuit || window.isDestroyed()) return;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  };
  app.on("activate", showWindow);
  app.on("second-instance", showWindow);
  app.on("will-quit", () => shortcuts.dispose());
  await loadRenderer(window, rendererUrl);
  if (!testMode && !ending) quickChat.scheduleWarmup((error) => errors.write("quick-chat.warmup", error));
  if (shortcutStartupError && !testMode && !ending)
    void dialog.showMessageBox(window, {
      type: "warning",
      title: "全局快捷键不可用",
      message: shortcutStartupError.message,
      detail: "应用内快捷键仍可使用。请在设置的快捷键页面更换全局组合或关闭它。",
    });
}

let draftFlushRequest = 0;
function flushDraftsBeforeQuit(window: BrowserWindow): Promise<void> {
  if (window.isDestroyed()) return Promise.resolve();
  const contents = window.webContents;
  if (contents.isDestroyed() || contents.isCrashed() || !contents.getURL()) return Promise.resolve();
  const request = ++draftFlushRequest;
  return new Promise((resolveFlush, rejectFlush) => {
    const finish = (error?: Error) => {
      clearTimeout(timer);
      ipcMain.removeListener("zpi:drafts-flushed", reply);
      contents.removeListener("render-process-gone", gone);
      contents.removeListener("destroyed", gone);
      if (error) rejectFlush(error);
      else resolveFlush();
    };
    const gone = () => finish();
    const reply = (event: Electron.IpcMainEvent, id: unknown, failure: unknown) => {
      if (
        event.sender !== contents ||
        event.senderFrame !== contents.mainFrame ||
        id !== request ||
        (failure !== null && typeof failure !== "string")
      )
        return;
      finish(failure === null ? undefined : new Error(failure));
    };
    const timer = setTimeout(() => finish(new Error("草稿保存确认超时，请重试退出")), 5000);
    ipcMain.on("zpi:drafts-flushed", reply);
    contents.once("render-process-gone", gone);
    contents.once("destroyed", gone);
    contents.send("zpi:prepare-quit", request);
  });
}
