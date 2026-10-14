import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { expect, test, vi } from "vitest";
import { desktopEnvironment, isolateDesktop } from "../../../tests/helpers/desktop-isolation.ts";

test("desktop launches isolate inherited dev and test settings while preserving OS environment", () => {
  const inherited = {
    PATH: "/bin",
    HOME: "/home/developer",
    USERPROFILE: "C:/Users/developer",
    APPDATA: "C:/Users/developer/AppData/Roaming",
    LOCALAPPDATA: "C:/Users/developer/AppData/Local",
    XDG_CONFIG_HOME: "/real/config",
    XDG_DATA_HOME: "/real/data",
    XDG_CACHE_HOME: "/real/cache",
    DISPLAY: ":99",
    MISSING: undefined,
    NODE_OPTIONS: "--inspect-brk",
    BASH_ENV: "/real/bash-startup",
    ENV: "/real/shell-startup",
    ELECTRON_RUN_AS_NODE: "1",
    ZPI_DEV_URL: "http://localhost:5173",
    ZPI_TEST_MODE: "0",
    ZPI_TEST_DATA_DIR: "/real/user-data",
    ZPI_TEST_PROJECT_DIR: "/real/project",
    ZPI_TEST_ATTACHMENT_FILES: '["/real/private-file"]',
    ZPI_TEST_IMAGE_FILES: '["/real/image"]',
    ZPI_TEST_PACKAGED_APP: "/real/ZPI.app",
    ZDOTDIR: "/real/shell-config",
    TMPDIR: "/real/tmp",
    TMP: "/real/tmp",
    TEMP: "/real/tmp",
  };
  expect(desktopEnvironment({ dir: "/tmp/test", url: "" }, inherited)).toEqual({
    PATH: "/bin",
    HOME: "/tmp/test",
    USERPROFILE: "/tmp/test",
    APPDATA: join("/tmp/test", "AppData", "Roaming"),
    LOCALAPPDATA: join("/tmp/test", "AppData", "Local"),
    XDG_CONFIG_HOME: join("/tmp/test", ".config"),
    XDG_DATA_HOME: join("/tmp/test", ".local", "share"),
    XDG_CACHE_HOME: join("/tmp/test", ".cache"),
    DISPLAY: ":99",
    ZPI_TEST_MODE: "1",
    ZPI_TEST_SHOW_WINDOW: "0",
    ZPI_TEST_AUTO_SELECTION: "0",
    ZPI_TEST_DATA_DIR: "/tmp/test",
    ZPI_TEST_BASE_URL: "",
    ZPI_TEST_IMAGE_FILES: "[]",
    ZDOTDIR: "/tmp/test",
    TMPDIR: "/tmp/test",
    TMP: "/tmp/test",
    TEMP: "/tmp/test",
  });
  expect(inherited.ZPI_TEST_PROJECT_DIR).toBe("/real/project");
});

test("desktop launches use explicit fixtures and retain the visible debugging opt-in", () => {
  expect(
    desktopEnvironment(
      { dir: "/tmp/test", url: "http://127.0.0.1:1234", project: "/tmp/project", images: ["/tmp/a.png"] },
      { ZPI_TEST_SHOW_WINDOW: "1" },
    ),
  ).toMatchObject({
    ZPI_TEST_SHOW_WINDOW: "1",
    ZPI_TEST_AUTO_SELECTION: "1",
    ZPI_TEST_BASE_URL: "http://127.0.0.1:1234",
    ZPI_TEST_PROJECT_DIR: "/tmp/project",
    ZPI_TEST_IMAGE_FILES: '["/tmp/a.png"]',
  });
  expect(desktopEnvironment({ dir: "/tmp/test", url: "" }, { ZPI_TEST_SHOW_WINDOW: "true" })).toHaveProperty(
    "ZPI_TEST_SHOW_WINDOW",
    "0",
  );
});

function services(): Parameters<typeof isolateDesktop>[0] & { native: ReturnType<typeof vi.fn> } {
  const native = vi.fn(() => {
    throw new Error("A native desktop method escaped isolation");
  });
  return {
    native,
    app: { getApplicationInfoForProtocol: native },
    clipboard: { readText: native, writeText: native },
    shell: { openPath: native, openExternal: native, showItemInFolder: native },
  };
}

test("copying uses per-launch memory, never reads or writes the system clipboard", () => {
  const first = services();
  const second = services();
  // Playwright serializes this callback into a separate process with no imported closures.
  const install = runInNewContext(`(${isolateDesktop.toString()})`) as typeof isolateDesktop;
  install(first);
  install(second);
  expect(first.clipboard.readText()).toBe("");
  first.clipboard.writeText("copied text");
  first.clipboard.writeText("selected text", "selection");
  expect(first.clipboard.readText()).toBe("copied text");
  expect(first.clipboard.readText("selection")).toBe("selected text");
  expect(second.clipboard.readText()).toBe("");
  expect(first.native).not.toHaveBeenCalled();
  expect(second.native).not.toHaveBeenCalled();
});

test("native open actions fail closed unless the specific test installs a fake", async () => {
  const desktop = services();
  isolateDesktop(desktop);
  await expect(desktop.app.getApplicationInfoForProtocol("file:///file")).rejects.toThrow(
    "No default application",
  );
  await expect(desktop.shell.openPath("/file")).rejects.toThrow("Mock shell.openPath");
  await expect(desktop.shell.openExternal("https://example.com")).rejects.toThrow("Mock shell.openExternal");
  expect(() => desktop.shell.showItemInFolder("/file")).toThrow("Mock shell.showItemInFolder");
  desktop.shell.openPath = vi.fn().mockResolvedValue("");
  await expect(desktop.shell.openPath("/fixture")).resolves.toBe("");
  expect(desktop.shell.openPath).toHaveBeenCalledExactlyOnceWith("/fixture");
  expect(desktop.native).not.toHaveBeenCalled();
});
