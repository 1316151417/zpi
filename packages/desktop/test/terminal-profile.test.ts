import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { beforeEach, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({ execFile: vi.fn() }));
vi.mock("node:fs/promises", () => ({ access: vi.fn() }));
vi.mock("node:os", () => ({ homedir: vi.fn(() => "/mock-home") }));

const home = "/mock-home";
const itermPath = `${home}/Library/Preferences/com.googlecode.iterm2.plist`;
const terminalPath = `${home}/Library/Preferences/com.apple.Terminal.plist`;
const files = new Map<string, unknown>();
let readTerminalProfile: typeof import("../src/main/terminal-profile.ts").readTerminalProfile;

beforeEach(async () => {
  vi.resetModules();
  ({ readTerminalProfile } = await import("../src/main/terminal-profile.ts"));
  vi.resetAllMocks();
  files.clear();
  vi.mocked(homedir).mockReturnValue(home);
  vi.mocked(access).mockImplementation(async (path) => {
    if (!files.has(String(path))) throw new Error("ENOENT");
  });
  vi.mocked(execFile).mockImplementation((...args: unknown[]) => {
    const fileArgs = args[1] as string[];
    const callback = args[3] as (error: Error | null, stdout: string) => void;
    const data = files.get(fileArgs.at(-1) ?? "");
    if (data instanceof Error) callback(data, "");
    else callback(null, typeof data === "string" ? data : JSON.stringify(data));
    return {} as ReturnType<typeof execFile>;
  });
});

it("never resolves HOME or reads preferences in application test mode", async () => {
  vi.stubEnv("ZPI_TEST_MODE", "1");
  expect(await readTerminalProfile("darwin")).toBeUndefined();
  expect(await readTerminalProfile("darwin", { HOME: "/must-not-read", ZPI_TEST_MODE: "1" })).toBeUndefined();
  expect(await readTerminalProfile("darwin", { ZPI_TEST_MODE: "1" })).toBeUndefined();
  expect(access).not.toHaveBeenCalled();
  expect(execFile).not.toHaveBeenCalled();
  expect(homedir).not.toHaveBeenCalled();
});

it("shares one in-flight profile lookup across concurrent and later requests", async () => {
  files.set(itermPath, { "New Bookmarks": [{ "Normal Font": "Menlo 13" }] });
  const pending = Promise.withResolvers<void>();
  vi.mocked(access).mockReturnValue(pending.promise);
  const first = readTerminalProfile("darwin", { HOME: home });
  const second = readTerminalProfile("darwin", { HOME: home });
  expect(second).toBe(first);
  expect(access).toHaveBeenCalledOnce();
  expect(execFile).not.toHaveBeenCalled();
  pending.resolve();
  expect(await first).toMatchObject({ fontFamily: "Menlo", fontSize: 13 });
  expect(await second).toEqual(await first);
  expect(await readTerminalProfile("darwin", { HOME: home })).toEqual(await first);
  expect(execFile).toHaveBeenCalledOnce();
  expect(access).toHaveBeenCalledOnce();
});

it("caches missing profiles while keeping different homes independent", async () => {
  expect(await readTerminalProfile("darwin", { HOME: home })).toBeUndefined();
  expect(await readTerminalProfile("darwin", { HOME: home })).toBeUndefined();
  expect(access).toHaveBeenCalledTimes(2);
  expect(await readTerminalProfile("darwin", { HOME: "/other-mock-home" })).toBeUndefined();
  expect(access).toHaveBeenCalledTimes(4);
  expect(execFile).not.toHaveBeenCalled();
});

it.each(["win32", "linux", "freebsd"] as const)(
  "does not inspect system profiles on %s",
  async (platform) => {
    expect(await readTerminalProfile(platform, { HOME: home })).toBeUndefined();
    expect(access).not.toHaveBeenCalled();
    expect(execFile).not.toHaveBeenCalled();
    expect(homedir).not.toHaveBeenCalled();
  },
);

it("inherits the marked iTerm default profile font, size, ANSI and selection but never base colors", async () => {
  files.set(itermPath, {
    "New Bookmarks": [
      { "Normal Font": "Other 10" },
      {
        "Default Bookmark": true,
        "Normal Font": "MesloLGS-NF-Regular 13",
        "Ansi 1 Color": { "Red Component": 1, "Green Component": 0.2, "Blue Component": 0.1 },
        "ANSI 9 Color": { Red: 255, Green: 102, Blue: 89 },
        "Selection Color": { red: 0.2, green: 0.4, blue: 1, alpha: 0.5 },
        "Foreground Color": "#ddd",
        "Background Color": "#222",
        "Cursor Color": "#fff",
        "Cursor Text Color": "#000",
      },
    ],
  });
  expect(await readTerminalProfile("darwin", { HOME: home })).toEqual({
    fontFamily: "MesloLGS NF Regular",
    fontSize: 13,
    theme: { red: "#ff331a", brightRed: "#ff6659", selectionBackground: "rgba(51, 102, 255, 0.5)" },
  });
  expect(execFile).toHaveBeenCalledExactlyOnceWith(
    "/usr/bin/plutil",
    ["-convert", "json", "-o", "-", itermPath],
    { encoding: "utf8", shell: false, windowsHide: true, timeout: 2_000, maxBuffer: 2 * 1024 * 1024 },
    expect.any(Function),
  );
  expect(access).toHaveBeenCalledTimes(1);
});

it("honors iTerm's default profile GUID before the first or legacy-marked profile", async () => {
  files.set(itermPath, {
    "Default Bookmark Guid": "selected",
    "New Bookmarks": [
      null,
      { "Default Bookmark": true, "Normal Font": "Other 12" },
      { Guid: "selected", "Normal Font": "JetBrainsMono-Nerd-Font 14.5" },
    ],
  });
  expect(await readTerminalProfile("darwin", { HOME: home })).toMatchObject({
    fontFamily: "JetBrainsMono Nerd Font",
    fontSize: 14.5,
  });
});

it("inherits a color-only profile without needing a font", async () => {
  files.set(itermPath, {
    "New Bookmarks": [
      { "Normal Font": {}, "Ansi 4 Color": "#3366ff", "Selection Color": "rgba(1, 2, 3, 0.4)" },
    ],
  });
  expect(await readTerminalProfile("darwin", { HOME: home })).toEqual({
    fontFamily: undefined,
    fontSize: undefined,
    theme: { blue: "#3366ff", selectionBackground: "rgba(1, 2, 3, 0.4)" },
  });
});

it.each([true, false])(
  "reads Terminal.app startup/default profiles with nested settings: %s",
  async (nested) => {
    const settings = {
      Startup: { Font: "Menlo-Regular 15", ANSIYellowColor: "#fedcba", SelectionColor: "#12345678" },
      Default: { FontName: "Other", FontSize: 20 },
    };
    files.set(terminalPath, {
      "Startup Window Settings": "Startup",
      "Default Window Settings": "Default",
      ...(nested ? { "Window Settings": settings } : settings),
    });
    expect(await readTerminalProfile("darwin", { HOME: home })).toEqual({
      fontFamily: "Menlo Regular",
      fontSize: 15,
      theme: { yellow: "#fedcba", selectionBackground: "#12345678" },
    });
  },
);

it("falls back to the named default when startup is missing and normalizes 16-bit RGB", async () => {
  files.set(terminalPath, {
    "Startup Window Settings": "Missing",
    "Default Window Settings": "Pro",
    "Window Settings": {
      Pro: {
        FontName: "SF Mono",
        FontSize: "14",
        ANSIBrightBlueColor: { Red: 0, Green: 32_768, Blue: 65_535 },
      },
    },
  });
  expect(await readTerminalProfile("darwin", { HOME: home })).toEqual({
    fontFamily: "SF Mono",
    fontSize: 14,
    theme: { brightBlue: "#0080ff" },
  });
});

it.each([true, false])(
  "reads a best-effort archived macOS font without exposing the archive to the renderer, wrapped: %s",
  async (wrapped) => {
    const archive = Buffer.from("bplist00\0Menlo-Regular\0").toString("base64");
    files.set(terminalPath, {
      "Default Window Settings": "Pro",
      Pro: { Font: wrapped ? { NS: archive } : archive, FontSize: 13 },
    });
    expect(await readTerminalProfile("darwin", { HOME: home })).toMatchObject({
      fontFamily: "Menlo Regular",
      fontSize: 13,
    });
  },
);

it("does not use undecodable archive data as a font family", async () => {
  files.set(terminalPath, {
    "Default Window Settings": "Pro",
    Pro: { Font: Buffer.from("bplist00\0Unknown\0").toString("base64"), FontSize: 13 },
  });
  expect(await readTerminalProfile("darwin", { HOME: home })).toMatchObject({
    fontFamily: undefined,
    fontSize: 13,
  });
});

it.each([new Error("timeout"), "invalid JSON", "[]", "null", {}])(
  "continues to Terminal.app after an unusable iTerm plist: %s",
  async (data) => {
    files.set(itermPath, data);
    files.set(terminalPath, {
      "Default Window Settings": "Basic",
      Basic: { FontName: "Monaco", FontSize: 12 },
    });
    expect(await readTerminalProfile("darwin", { HOME: home })).toMatchObject({
      fontFamily: "Monaco",
      fontSize: 12,
    });
  },
);

it("falls back without invoking plutil when neither preferences file exists", async () => {
  expect(await readTerminalProfile("darwin", { HOME: home })).toBeUndefined();
  expect(access).toHaveBeenCalledTimes(2);
  expect(execFile).not.toHaveBeenCalled();
});

it.each([5, 73, Number.POSITIVE_INFINITY, "invalid"])("ignores invalid font size %s", async (size) => {
  files.set(terminalPath, { "Default Window Settings": "Basic", Basic: { FontSize: size } });
  expect(await readTerminalProfile("darwin", { HOME: home })).toBeUndefined();
});

it("ignores invalid colors and unrelated settings without returning an empty profile", async () => {
  files.set(itermPath, {
    "New Bookmarks": [
      {
        "Ansi 0 Color": "url(https://invalid.test)",
        "Ansi 1 Color": { red: -1, green: 1, blue: 1 },
        "Cursor Color": "#fff",
      },
    ],
  });
  expect(await readTerminalProfile("darwin", { HOME: home })).toBeUndefined();
});

it.each([{ USERPROFILE: home }, {}])("resolves a home directory when HOME is absent: %j", async (env) => {
  files.set(itermPath, { "New Bookmarks": [{ "Normal Font": "Monaco 12" }] });
  expect(await readTerminalProfile("darwin", env)).toMatchObject({ fontFamily: "Monaco", fontSize: 12 });
});
