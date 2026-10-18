// Dedicated native lifecycle fixture: real host, controller, preload and renderer.
// Loaded only by launchDesktop, with the same isolation and cleanup contract.
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { app, ipcMain, screen, systemPreferences } from "electron";
import { createDesktopWindow, hiddenTestMode } from "../../packages/desktop/src/main/automation.ts";
import { QuickChatHost } from "../../packages/desktop/src/main/quick-chat-host.ts";
import { QuickChatTiming } from "../../packages/desktop/src/main/quick-chat-timing.ts";
import { installQuickChatIpc, QuickChatWindow } from "../../packages/desktop/src/main/quick-chat-window.ts";
import { SettingsStore } from "../../packages/desktop/src/main/storage.ts";

void app.whenReady().then(async () => {
  const root = app.getPath("userData");
  const settings = new SettingsStore(join(root, "settings"), {
    isEncryptionAvailable: () => false,
    encryptString: () => Buffer.alloc(0),
    decryptString: () => "",
  });
  if (process.env.ZPI_TEST_BASE_URL)
    settings.save({
      baseUrl: process.env.ZPI_TEST_BASE_URL,
      modelId: "fake",
      apiKey: "local-test-key",
      reasoning: false,
      supportsImages: false,
      contextWindow: 32768,
      maxTokens: 4096,
    });
  // Replaced at fixture build time; never read an arbitrary renderer from inherited env.
  const assets = process.env.ZPI_QUICK_CHAT_FIXTURE_ASSETS as string;
  let clockOffset = 0;
  const host = new QuickChatHost(
    settings,
    join(root, "workspace"),
    fetch,
    () => performance.now() + clockOffset,
  );
  const quick = new QuickChatWindow({
    host,
    timing: new QuickChatTiming(root, true),
    createWindow: createDesktopWindow,
    rendererUrl: pathToFileURL(join(assets, "renderer/quick-chat.html")).href,
    preload: join(assets, "preload/quick-chat.cjs"),
    hiddenTestMode,
    platform: process.platform,
    getDisplay: (bounds) => (bounds ? screen.getDisplayMatching(bounds) : screen.getPrimaryDisplay()),
    workspaceNotifications: systemPreferences,
    loadSourceIcon: async () => undefined,
    copyText: () => {
      throw new Error("No clipboard in lifecycle fixture");
    },
    openExternal: async () => {
      throw new Error("No external applications in lifecycle fixture");
    },
  });
  installQuickChatIpc(ipcMain, quick);
  Object.assign(globalThis, {
    quickChatFixture: quick,
    expireQuickChatFixture: () => {
      clockOffset += 15 * 60 * 1000;
    },
  });
  let closing = false;
  app.on("before-quit", (event) => {
    if (closing) return;
    event.preventDefault();
    void quick.dispose().finally(() => {
      settings.state.close();
      closing = true;
      app.quit();
    });
  });
  await quick.prepare();
});
