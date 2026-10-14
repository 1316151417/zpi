import { expect, it } from "vitest";
import { terminalShell } from "../src/main/terminal-shell.ts";

it("uses the Windows command processor without POSIX login arguments", () => {
  expect(terminalShell("win32", { ComSpec: "C:\\Windows\\System32\\cmd.exe", SHELL: "/bin/bash" })).toEqual({
    shell: "C:\\Windows\\System32\\cmd.exe",
    args: [],
  });
});

it("accepts uppercase COMSPEC on Windows", () => {
  expect(terminalShell("win32", { COMSPEC: "C:\\Windows\\System32\\cmd.exe" })).toEqual({
    shell: "C:\\Windows\\System32\\cmd.exe",
    args: [],
  });
});

it.each([{}, { ComSpec: "", COMSPEC: "", SHELL: "/bin/bash" }])(
  "falls back to cmd.exe when Windows has no command processor configured: %j",
  (env) => {
    expect(terminalShell("win32", env)).toEqual({ shell: "cmd.exe", args: [] });
  },
);

it.each(["darwin", "linux"] as const)("preserves configured login shells on %s", (platform) => {
  expect(terminalShell(platform, { SHELL: "/opt/local/bin/fish" })).toEqual({
    shell: "/opt/local/bin/fish",
    args: ["-l"],
  });
});

it("keeps the macOS zsh fallback", () => {
  expect(terminalShell("darwin", {})).toEqual({ shell: "/bin/zsh", args: ["-l"] });
});

it("uses the portable sh fallback on other POSIX platforms", () => {
  expect(terminalShell("linux", { SHELL: "" })).toEqual({ shell: "/bin/sh", args: ["-l"] });
});
