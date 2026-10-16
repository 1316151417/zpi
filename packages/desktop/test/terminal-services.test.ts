import { spawn } from "node-pty";
import { beforeEach, expect, it, vi } from "vitest";
import { PaneServices } from "../src/main/pane-services.ts";
import { readTerminalProfile } from "../src/main/terminal-profile.ts";
import type { TerminalProfile } from "../src/shared/bridge.ts";

vi.mock("electron", () => ({ session: {}, WebContentsView: vi.fn() }));
vi.mock("node-pty", () => ({ spawn: vi.fn() }));
vi.mock("../src/main/terminal-profile.ts", () => ({ readTerminalProfile: vi.fn() }));
vi.mock("../src/main/terminal-shell.ts", () => ({
  terminalShell: () => ({ shell: "/bin/zsh", args: ["-l"] }),
}));

const pty = { onData: vi.fn(), onExit: vi.fn(), write: vi.fn(), resize: vi.fn(), kill: vi.fn() };
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(spawn).mockReturnValue(pty as unknown as ReturnType<typeof spawn>);
});

it("returns the inherited profile without changing PTY creation, environment, events or teardown", async () => {
  const profile: TerminalProfile = { fontFamily: "Menlo", fontSize: 14, theme: { red: "#ff0000" } };
  vi.mocked(readTerminalProfile).mockResolvedValue(profile);
  vi.stubEnv("ELECTRON_RUN_AS_NODE", "1");
  const emit = vi.fn();
  const services = new PaneServices({} as never, emit);
  const result = await services.createTerminal("/mock-workspace");
  expect(result).toEqual({ id: expect.any(String), shell: "zsh", profile });
  expect(spawn).toHaveBeenCalledWith("/bin/zsh", ["-l"], {
    cwd: "/mock-workspace",
    name: "xterm-256color",
    cols: 80,
    rows: 24,
    env: expect.objectContaining({ TERM: "xterm-256color" }),
  });
  expect(vi.mocked(spawn).mock.calls[0][2]?.env).not.toHaveProperty("ELECTRON_RUN_AS_NODE");
  const data = pty.onData.mock.calls[0][0] as (data: string) => void;
  data("prompt");
  expect(emit).toHaveBeenLastCalledWith({ type: "terminal", id: result.id, data: "prompt" });
  services.terminalInput(result.id, "pwd\r");
  services.resizeTerminal(result.id, 100, 40);
  expect(pty.write).toHaveBeenCalledWith("pwd\r");
  expect(pty.resize).toHaveBeenCalledWith(100, 40);
  services.closeTerminal(result.id);
  expect(pty.kill).toHaveBeenCalledOnce();
  data("ignored after close");
  expect(emit).toHaveBeenCalledOnce();
});

it("waits for profile detection before starting a PTY and preserves the terminal limit across concurrent opens", async () => {
  const pending = Promise.withResolvers<TerminalProfile | undefined>();
  vi.mocked(readTerminalProfile).mockReturnValue(pending.promise);
  const services = new PaneServices({} as never, vi.fn());
  const opens: ReturnType<PaneServices["createTerminal"]>[] = [];
  for (let index = 0; index < 13; index += 1) {
    opens.push(services.createTerminal("/mock-workspace"));
    await vi.dynamicImportSettled();
  }
  expect(spawn).not.toHaveBeenCalled();
  pending.resolve(undefined);
  const results = await Promise.allSettled(opens);
  expect(results.filter((result) => result.status === "rejected").map((result) => result.reason)).toEqual([
    expect.objectContaining({ message: "busy: 请先关闭部分终端" }),
  ]);
  expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(12);
  expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
  expect(spawn).toHaveBeenCalledTimes(12);
});

it("preserves exit events when no native profile exists", async () => {
  vi.mocked(readTerminalProfile).mockResolvedValue(undefined);
  const emit = vi.fn();
  const services = new PaneServices({} as never, emit);
  const result = await services.createTerminal("/mock-workspace");
  expect(result.profile).toBeUndefined();
  const exit = pty.onExit.mock.calls[0][0] as (event: { exitCode: number }) => void;
  exit({ exitCode: 0 });
  expect(emit).toHaveBeenLastCalledWith({
    type: "terminal",
    id: result.id,
    data: "\r\n[终端已退出 0]\r\n",
    exited: true,
  });
  services.closeTerminal(result.id);
  expect(pty.kill).not.toHaveBeenCalled();
});

it("does not create an orphan PTY if the window closes during profile detection", async () => {
  const pending = Promise.withResolvers<TerminalProfile | undefined>();
  vi.mocked(readTerminalProfile).mockReturnValue(pending.promise);
  const services = new PaneServices({} as never, vi.fn());
  const opening = services.createTerminal("/mock-workspace");
  await vi.dynamicImportSettled();
  services.close();
  pending.resolve({ fontFamily: "Menlo", fontSize: 13 });
  await expect(opening).rejects.toThrow("not_found: 窗口已关闭");
  expect(spawn).not.toHaveBeenCalled();
  expect(pty.onData).not.toHaveBeenCalled();
  expect(pty.onExit).not.toHaveBeenCalled();
});

it("rejects terminal creation after disposal before loading a profile or spawning", async () => {
  const services = new PaneServices({} as never, vi.fn());
  services.close();
  await expect(services.createTerminal("/mock-workspace")).rejects.toThrow("not_found: 窗口已关闭");
  expect(readTerminalProfile).not.toHaveBeenCalled();
  expect(spawn).not.toHaveBeenCalled();
});
