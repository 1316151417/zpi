import { expect, it } from "vitest";
import { terminalShell } from "../src/main/terminal-shell.ts";

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
