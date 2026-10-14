import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { fileChanges } from "../src/main/file-changes.ts";

const state = vi.hoisted(() => ({
  mode: "message" as "message" | "error" | "exit" | "hang",
  workers: [] as { terminate: ReturnType<typeof vi.fn> }[],
  ready: undefined as (() => void) | undefined,
}));
vi.mock("node:worker_threads", () => ({
  Worker: class extends EventEmitter {
    terminate = vi.fn(async () => 0);
    constructor() {
      super();
      state.workers.push(this);
      state.ready?.();
      queueMicrotask(() => {
        if (state.mode === "message") this.emit("message", "patch");
        if (state.mode === "error") this.emit("error", new Error("worker failed"));
        if (state.mode === "exit") this.emit("exit", 0);
      });
    }
  },
}));
const roots: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  state.workers = [];
  state.ready = undefined;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function input() {
  const root = await mkdtemp(join(tmpdir(), "zpi-diff-worker-"));
  roots.push(root);
  const afterFile = join(root, "after");
  await writeFile(afterFile, "after\n");
  return {
    root,
    changes: [
      {
        path: "file.txt",
        toolCallId: "write",
        operation: "created" as const,
        beforeHash: null,
        afterHash: "after",
        afterFile,
      },
    ],
  };
}
test.each(["error", "exit"] as const)(
  "a worker %s is cleaned up without poisoning the next diff",
  async (mode) => {
    const { root, changes } = await input();
    state.mode = mode;
    const [failed] = await fileChanges(changes, root, "task");
    expect(failed.reason).toContain(mode === "error" ? "worker failed" : "exited before replying");
    expect(state.workers[0].terminate).toHaveBeenCalledOnce();
    state.mode = "message";
    expect((await fileChanges(changes, root, "task"))[0].patch).toBe("patch");
    expect(state.workers[1].terminate).toHaveBeenCalledOnce();
  },
);
test("a worker that never replies is terminated by the startup/completion watchdog", async () => {
  const { root, changes } = await input();
  state.mode = "hang";
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const ready = new Promise<void>((resolve) => {
    state.ready = resolve;
  });
  const result = fileChanges(changes, root, "task");
  await ready;
  await vi.advanceTimersByTimeAsync(5000);
  expect((await result)[0].reason).toBe("文件已变化，比对超时");
  expect(state.workers[0].terminate).toHaveBeenCalledOnce();
});
