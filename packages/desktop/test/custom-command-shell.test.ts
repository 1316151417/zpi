import { expect, it, vi } from "vitest";
import { runCustomCommandShell } from "../src/main/custom-command-shell.ts";

it("uses existing shell operations with session cwd/env, timeout and separate stdout", async () => {
  const context = {
    cwd: "/tmp/fixture-project",
    sessionId: "session-a",
    signal: new AbortController().signal,
  };
  const exec = vi.fn(async (_command, _cwd, options) => {
    options.onData(Buffer.from("warning"), "stderr");
    options.onData(Buffer.from("value\n"), "stdout");
    return { exitCode: 0 };
  });
  expect(await runCustomCommandShell("fixture-only", context, { exec })).toBe("value");
  expect(exec).toHaveBeenCalledWith(
    "fixture-only",
    context.cwd,
    expect.objectContaining({
      timeout: 30,
      signal: context.signal,
      env: expect.objectContaining({ ZPI_SESSION_ID: "session-a", CLAUDE_PROJECT_DIR: context.cwd }),
    }),
  );
});
it("propagates exit failures and bounds output without running a real process", async () => {
  const context = { cwd: "/tmp/fixture", sessionId: "s", signal: new AbortController().signal };
  await expect(
    runCustomCommandShell("fixture", context, {
      exec: async (_command, _cwd, options) => {
        options.onData(Buffer.from("failed"), "stderr");
        return { exitCode: 2 };
      },
    }),
  ).rejects.toThrow("failed");
  await expect(
    runCustomCommandShell("fixture", context, {
      exec: async (_command, _cwd, options) => {
        options.onData(Buffer.alloc(128 * 1024 + 1), "stdout");
        return { exitCode: 0 };
      },
    }),
  ).rejects.toThrow("128 KiB");
});
it("never invokes backend when aborted or plugin/skill context is unavailable", async () => {
  const controller = new AbortController();
  const exec = vi.fn(async () => ({ exitCode: 0 }));
  const context = { cwd: "/tmp/fixture", sessionId: "s", signal: controller.signal };
  // biome-ignore lint/suspicious/noTemplateCurlyInString: test the literal shell variable syntax.
  await expect(runCustomCommandShell("${ZCODE_PLUGIN_ROOT}", context, { exec })).rejects.toThrow("上下文");
  controller.abort();
  await expect(runCustomCommandShell("fixture", context, { exec })).rejects.toThrow();
  expect(exec).not.toHaveBeenCalled();
});
