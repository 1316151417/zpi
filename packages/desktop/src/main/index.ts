import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  nativeTheme,
  net,
  safeStorage,
  screen,
  shell,
} from "electron";
import { fetchProviderModels, getProviderPreset, type ModelDiscoveryInput, usesChatGPTAuth } from "zpi-ai";
import { imageLimits, listCommands } from "zpi-coding-agent";
import type {
  CombinedSelection,
  ErrorCode,
  InterfacePreferences,
  ProviderInput,
  Result,
  RunInput,
} from "../shared/bridge.ts";
import { methods } from "../shared/bridge.ts";
import { browserUrl } from "./browser-url.ts";
import { ChatGPTAuth } from "./chatgpt-auth.ts";
import { performFileAction } from "./file-actions.ts";
import { readFilePreview } from "./file-preview.ts";
import { loadRenderer } from "./load-renderer.ts";
import { PaneServices } from "./pane-services.ts";
import { SessionHost } from "./session-host.ts";
import { shellEnvironment } from "./shell-environment.ts";
import { SettingsStore } from "./storage.ts";
import { TaskNotifications } from "./task-notifications.ts";

const dir = fileURLToPath(new URL(".", import.meta.url));
const testMode = process.env.ZPI_TEST_MODE === "1";
const requestFetch: typeof fetch = (input, init) =>
  net.fetch(input instanceof URL ? input.href : input, { ...init, credentials: "omit" });
let ending = false;
if (testMode && process.env.ZPI_TEST_DATA_DIR) app.setPath("userData", process.env.ZPI_TEST_DATA_DIR);
if (!app.requestSingleInstanceLock()) app.quit();
else
  void launch().catch((error) => {
    if (!ending) {
      if (testMode) console.error("zpi 启动失败", error);
      else dialog.showErrorBox("zpi 启动失败", error instanceof Error ? error.message : String(error));
    }
    app.quit();
  });
async function launch(): Promise<void> {
  await app.whenReady();
  if (!testMode) Object.assign(process.env, await shellEnvironment());
  const icon = app.isPackaged ? join(process.resourcesPath, "icon.png") : resolve("icon.png");
  app.dock?.setIcon(icon);
  const encryption = testMode
    ? { isEncryptionAvailable: () => false, encryptString: () => Buffer.alloc(0), decryptString: () => "" }
    : safeStorage;
  const settings = new SettingsStore(app.getPath("userData"), encryption);
  nativeTheme.themeSource = settings.get().interface.theme;
  const discovered = testMode ? [] : settings.discoverEnvironment(process.env);
  const chatgptAuth = new ChatGPTAuth(settings, requestFetch);
  app.on("before-quit", () => chatgptAuth.close());
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
    app.getPath("userData"),
    settings,
    testMode ? join(app.getPath("userData"), "resources") : join(homedir(), ".zpi", "agent"),
    testMode ? join(app.getPath("userData"), "workspace") : join(homedir(), "Documents", "ZPI"),
    requestFetch,
    testMode ? [join(app.getPath("userData"), ".agents", "skills")] : undefined,
  );
  await host.init();
  const display = screen.getPrimaryDisplay().workAreaSize;
  const window = new BrowserWindow({
    width: Math.min(1200, display.width),
    height: Math.min(800, display.height),
    minWidth: 740,
    minHeight: 560,
    title: "zpi",
    backgroundColor: "#f8f8f8",
    icon,
    // 与 ZCode 的 macOS 顶栏一致，让原生红绿灯和侧栏开关位于同一排。
    titleBarStyle: process.platform === "darwin" ? "hidden" : "default",
    ...(process.platform === "darwin"
      ? {
          backgroundColor: "#00000000",
          trafficLightPosition: { x: 22, y: 23 },
          vibrancy: "under-window",
          visualEffectState: "active",
        }
      : {}),
    webPreferences: {
      preload: join(dir, "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });
  const settingsReady = new Promise<void>((resolveReady) =>
    window.webContents.once("did-finish-load", () => resolveReady()),
  );
  for (const id of discovered) {
    const original = settings.snapshot(id);
    void fetchProviderModels({ preset: original.preset, apiKey: original.apiKey }, requestFetch)
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
        if (!window.isDestroyed()) window.webContents.send("zpi:settings", settings.get());
      })
      .catch(() => {
        /* Keep the usable catalog; settings offers explicit retry. */
      });
  }
  const panes = new PaneServices(window, (event) => {
    if (!window.isDestroyed()) window.webContents.send("zpi:pane-event", event);
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (e) => e.preventDefault());
  window.webContents.on("will-redirect", (e) => e.preventDefault());
  window.webContents.session.setPermissionRequestHandler((_, __, cb) => cb(false));
  window.webContents.session.setPermissionCheckHandler(() => false);
  const notifications = new TaskNotifications(window, () => settings.get().interface);
  host.subscribe((event) => {
    if (!window.isDestroyed()) window.webContents.send("zpi:event", event);
    if (!ending && event.event.type === "settled")
      notifications.handle(
        event,
        host.listRecentSessions().find((record) => record.id === event.sessionId)?.title ?? "",
      );
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
        activateSession: 1,
        archiveSession: 1,
        listArchivedSessions: 0,
        restoreSession: 1,
        openSessionDirectory: 1,
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
        fileAction: 3,
        searchFiles: 2,
        getWorkspaceInfo: 1,
        readFilePreview: 3,
        downloadImage: 1,
        importImage: 3,
        pickImages: 1,
        readAttachment: 2,
        removeAttachment: 2,
        getChanges: 2,
        readPatch: 3,
        previewPrompt: 0,
        listTools: 0,
        getSkillSettings: 0,
        readSkill: 1,
        setSkillEnabled: 2,
        listProjects: 0,
        addProject: 0,
        removeProject: 1,
        listSessions: 1,
        listRecentSessions: 0,
        setSessionPinned: 2,
        getProviderCredentials: 1,
        updatePreferences: 1,
        setSessionSelection: 2,
        listSessionSkills: 1,
        createSession: 1,
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
        beginChatGPTLogin: 1,
        completeChatGPTLogin: 1,
        submitChatGPTCallback: 2,
        cancelChatGPTLogin: 1,
        disconnectChatGPT: 1,
        openExternal: 1,
        saveProvider: 1,
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
        case "archiveSession":
          await host.archiveSession(string(0));
          break;
        case "listArchivedSessions":
          value = host.listArchivedSessions();
          break;
        case "restoreSession":
          value = host.restoreSession(string(0));
          break;
        case "openSessionDirectory": {
          const failure = await shell.openPath(host.workspaceInfo(string(0)).cwd);
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
        case "copyText": {
          const text = string(0);
          if (Buffer.byteLength(text, "utf8") > 2 * 1024 * 1024)
            throw new Error("invalid_input: 复制内容超过 2 MiB");
          clipboard.writeText(text);
          break;
        }
        case "fileAction":
          await performFileAction(host.workspaceInfo(string(0)).cwd, string(1), string(2), {
            openPath: (path) => shell.openPath(path),
            showItemInFolder: (path) => shell.showItemInFolder(path),
            writeText: (text) => clipboard.writeText(text),
          });
          break;
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
        case "readFilePreview":
          value = await readFilePreview(host.workspaceInfo(string(0)).cwd, string(1), args[2]);
          break;
        case "importImage": {
          if (!(args[2] instanceof Uint8Array)) throw new Error("invalid_input: 图片必须为二进制数据");
          value = await host.importImage(string(0), string(1), args[2]);
          break;
        }
        case "pickImages": {
          const id = string(0);
          host.workspaceInfo(id);
          const paths = testMode
            ? (JSON.parse(process.env.ZPI_TEST_IMAGE_FILES ?? "[]") as string[])
            : (
                await dialog.showOpenDialog(window, {
                  properties: ["openFile", "multiSelections"],
                  filters: [{ name: "图片", extensions: ["png", "jpg", "jpeg", "gif", "webp", "bmp"] }],
                })
              ).filePaths;
          if (paths.length > 8) throw new Error("invalid_input: 每条消息最多 8 张图片");
          const imported = [];
          try {
            for (const path of paths) {
              if ((await stat(path)).size > imageLimits.sourceBytes)
                throw new Error("invalid_input: 图片单张上限为 10 MiB");
              imported.push(await host.importImage(id, basename(path), await readFile(path)));
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
          value = await host.getChanges(string(0), args[1] === null ? null : string(1));
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
          let path: string | undefined;
          if (testMode) path = process.env.ZPI_TEST_PROJECT_DIR;
          else {
            const selected = await dialog.showOpenDialog(window, { properties: ["openDirectory"] });
            path = selected.canceled ? undefined : selected.filePaths[0];
          }
          value = path ? await host.addProject(path) : null;
          break;
        }
        case "removeProject":
          value = host.removeProject(string(0));
          break;
        case "listSessions":
          value = host.listSessions(string(0));
          break;
        case "listRecentSessions":
          value = host.listRecentSessions();
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
        case "updatePreferences":
          value = settings.updatePreferences(
            object(0, [
              "theme",
              "fontSize",
              "showContextUsage",
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
          value = host.createSession(args[0] === null ? null : string(0));
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
          const input = object(0, ["preset", "providerId", "baseUrl", "apiKey"]);
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
        case "saveProvider": {
          const input = object(0, ["id", "name", "baseUrl", "models", "apiKey", "preset", "enabled"]);
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
      return { ok: true, value };
    } catch (error) {
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
  app.on("before-quit", (event) => {
    ending = true;
    if (quitting) return;
    event.preventDefault();
    quitting = true;
    notifications.dispose();
    panes.close();
    void host.close().finally(() => app.quit());
  });
  window.on("close", (event) => {
    if (!quitting) {
      event.preventDefault();
      app.quit();
    }
  });
  app.on("second-instance", () => {
    if (window.isMinimized()) window.restore();
    window.focus();
  });
  const devUrl = process.env.ZPI_DEV_URL;
  await loadRenderer(window, devUrl ?? pathToFileURL(join(dir, "../renderer/index.html")).href);
}
