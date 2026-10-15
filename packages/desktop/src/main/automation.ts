import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { app, BrowserWindow, clipboard, dialog, globalShortcut, Menu, Notification, shell } from "electron";

export const testMode = process.env.ZPI_TEST_MODE === "1";
export const hiddenTestMode = testMode && process.env.ZPI_TEST_INTERACTIVE !== "1";
// A versioned preflight marker also prevents launching old packaged apps without these guards.
export const automationContract = "zpi-desktop-isolation-v2";
const violations: string[] = [];
const windows = new Map<number, () => { visible: boolean; focused: boolean; focusable: boolean }>();
function forbidden(name: string): never {
  violations.push(name);
  throw new Error(`Desktop test blocked ${name}; use an explicit fake or the interactive suite`);
}

if (testMode) {
  Object.assign(globalThis, {
    __zpiAutomation: {
      contract: automationContract,
      violations,
      createWindow: createDesktopWindow,
      snapshot: () => [...windows.values()].map((read) => read()),
    },
  });
  const root = process.env.ZPI_TEST_DATA_DIR;
  if (
    !root ||
    !isAbsolute(root) ||
    readFileSync(join(root, ".zpi-test-owner"), "utf8") !== automationContract
  )
    throw new Error("Desktop tests must use the shared launcher and an owned data directory");
  app.setPath("userData", root);
  app.setPath("sessionData", join(root, "chromium"));
  app.commandLine.appendSwitch("mute-audio");
  app.commandLine.appendSwitch("use-mock-keychain");
  app.commandLine.appendSwitch("password-store", "basic");
  if (hiddenTestMode && process.platform === "darwin") app.setActivationPolicy("prohibited");

  // Install before app.whenReady(), renderer loading, or any application services.
  // Text stays inside this process. Other native formats fail closed.
  const text = new Map<string, string>();
  for (const key of Object.keys(clipboard)) {
    if (typeof clipboard[key as keyof typeof clipboard] === "function")
      Object.assign(clipboard, { [key]: () => forbidden(`clipboard.${key}`) });
  }
  clipboard.writeText = (value, type = "clipboard") => {
    text.set(type, value);
  };
  clipboard.readText = (type = "clipboard") => text.get(type) ?? "";
  clipboard.clear = (type = "clipboard") => {
    text.delete(type);
  };
  clipboard.availableFormats = () => ["text/plain"];
  app.getApplicationInfoForProtocol = async () => {
    throw new Error("No default application in desktop tests");
  };
  for (const key of ["openPath", "openExternal", "showItemInFolder", "beep", "trashItem"] as const)
    Object.assign(shell, { [key]: () => forbidden(`shell.${key}`) });
  for (const key of [
    "showOpenDialog",
    "showOpenDialogSync",
    "showSaveDialog",
    "showSaveDialogSync",
    "showMessageBox",
    "showMessageBoxSync",
    "showErrorBox",
    "showCertificateTrustDialog",
  ] as const)
    Object.assign(dialog, { [key]: () => forbidden(`dialog.${key}`) });
  // Notification delivery and sound bridge remain real; only OS presentation is intercepted.
  Notification.prototype.show = () => {};
  for (const key of ["register", "registerAll"] as const)
    Object.assign(globalShortcut, { [key]: () => forbidden(`globalShortcut.${key}`) });
  app.relaunch = () => forbidden("app.relaunch");
  Menu.prototype.popup = () => forbidden("Menu.popup");
  if (hiddenTestMode) {
    for (const key of ["show", "focus"] as const)
      Object.assign(app, { [key]: () => forbidden(`app.${key}`) });
    if (app.dock) {
      app.dock.show = async () => forbidden("dock.show");
      app.dock.bounce = () => forbidden("dock.bounce");
    }
  }
  app.on("session-created", (session) => {
    session.setPermissionRequestHandler((_, __, reply) => reply(false));
    session.setPermissionCheckHandler(() => false);
    session.on("will-download", (event) => event.preventDefault());
  });
  app.on("web-contents-created", (_, contents) => {
    contents.openDevTools = () => forbidden("webContents.openDevTools");
    for (const key of ["copy", "cut", "paste", "pasteAndMatchStyle"] as const)
      contents[key] = () => forbidden(`webContents.${key}`);
    contents.setWindowOpenHandler(() => ({ action: "deny" }));
    contents.on("before-input-event", (event, input) => {
      if ((input.meta || input.control) && ["c", "v", "x"].includes(input.key.toLowerCase()))
        event.preventDefault();
    });
    contents.on("select-bluetooth-device", (event, _, callback) => {
      event.preventDefault();
      callback("");
    });
  });
}

/** Every app/fixture BrowserWindow goes through this factory, including future child windows. */
export function createDesktopWindow(options: Electron.BrowserWindowConstructorOptions): BrowserWindow {
  const window = new BrowserWindow({
    ...options,
    ...(hiddenTestMode
      ? { show: false, focusable: false, skipTaskbar: true, modal: false, fullscreen: false, kiosk: false }
      : {}),
    webPreferences: {
      ...options.webPreferences,
      ...(testMode
        ? {
            devTools: false,
            disableDialogs: true,
            disableHtmlFullscreenWindowResize: true,
            additionalArguments: [
              ...(options.webPreferences?.additionalArguments ?? []),
              "--zpi-test-isolation",
            ],
          }
        : {}),
      ...(hiddenTestMode ? { backgroundThrottling: false } : {}),
    },
  });
  if (testMode) {
    const visible = window.isVisible.bind(window);
    const focused = window.isFocused.bind(window);
    const focusable = window.isFocusable.bind(window);
    windows.set(window.id, () => ({ visible: visible(), focused: focused(), focusable: focusable() }));
    window.once("closed", () => windows.delete(window.id));
  }
  if (hiddenTestMode) {
    for (const key of [
      "show",
      "showInactive",
      "focus",
      "restore",
      "minimize",
      "maximize",
      "moveTop",
      "previewFile",
    ] as const)
      window[key] = () => forbidden(`window.${key}`);
    const setEnabled = window.setEnabled.bind(window);
    window.setEnabled = (value) => {
      if (!value) forbidden("window.setEnabled(false)");
      setEnabled(true);
    };
    const setFocusable = window.setFocusable.bind(window);
    window.setFocusable = (value) => {
      if (value) forbidden("window.setFocusable");
      setFocusable(false);
    };
    for (const key of ["setFullScreen", "setSimpleFullScreen", "setKiosk"] as const)
      window[key] = (value: boolean) => {
        if (value) forbidden(`window.${key}`);
      };
    window.flashFrame = (value) => {
      if (value) forbidden("window.flashFrame");
    };
    window.on("show", () => {
      window.hide();
      forbidden("window show event");
    });
    window.on("focus", () => {
      window.blur();
      forbidden("window focus event");
    });
  }
  return window;
}
