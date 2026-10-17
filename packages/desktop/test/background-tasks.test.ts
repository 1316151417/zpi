import { mkdtemp, readdir, readFile, rm, stat, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import type { AgentToolUpdateCallback } from "zpi-agent";
import { SessionManager } from "zpi-coding-agent";
import { fakeModel } from "../../../tests/fake-server.ts";
import { BackgroundTasks } from "../src/main/background-tasks.ts";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.unstubAllEnvs();
});
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "zpi-background-"));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const port = { publish: vi.fn(), notify: vi.fn(async () => {}), error: vi.fn() };
  const runtime = new BackgroundTasks(dir, port);
  cleanup.push(() => runtime.close());
  const invoke = (params: unknown, signal?: AbortSignal, cwd = dir, update?: AgentToolUpdateCallback) =>
    runtime.tool("owner", cwd).execute("call", params, signal, update, {
      cwd,
      model: fakeModel(""),
      sessionManager: SessionManager.inMemory(),
      isIdle: () => false,
      getSystemPrompt: () => "",
    });
  const launch = async (command = "echo ready; sleep 30") => {
    await invoke({ command, description: "Service", run_in_background: true });
    const task = runtime.list("owner").at(-1);
    if (!task) throw new Error("Missing background task");
    return task;
  };
  return { dir, runtime, port, invoke, launch };
}

test.skipIf(process.platform === "win32")(
  "tracks foreground shell descendants after their root exits and stops them on close",
  async () => {
    const f = await fixture();
    const result = await f.invoke({ command: "sleep 30 & echo $!" });
    const task = f.runtime.list("owner")[0];
    expect(task).toMatchObject({ status: "running", autoBackgrounded: true });
    expect(result.content[0]).toMatchObject({ text: expect.stringContaining(task.taskId) });
    const pid = Number((await f.runtime.read("owner", task.taskId)).output.trim());
    expect(Number.isSafeInteger(pid) && pid > 1 && pid !== process.pid).toBe(true);
    const alive = () => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    try {
      expect(alive()).toBe(true);
      await f.runtime.close();
      expect(alive()).toBe(false);
      expect(f.runtime.list("owner")[0].status).toBe("cancelled");
    } finally {
      if (alive()) process.kill(pid, "SIGTERM");
    }
  },
);

test("background launch detaches from turn abort and timeout; owner can read and stop the process tree", async () => {
  const f = await fixture();
  const abort = new AbortController();
  const result = await f.invoke(
    { command: "echo ready; sleep 30 & echo $!; wait", timeout: 10, run_in_background: true },
    abort.signal,
  );
  const task = f.runtime.list("owner")[0];
  expect(result.content[0]).toMatchObject({ text: expect.stringContaining(task.taskId) });
  abort.abort();
  await expect.poll(async () => (await f.runtime.read("owner", task.taskId)).output).toContain("ready");
  const pid = Number((await readFile(task.outputPath, "utf8")).trim().split("\n").at(-1));
  expect(task.status).toBe("running");
  await expect(f.runtime.stop("other", task.taskId)).rejects.toThrow("不存在");
  await expect(f.runtime.read("other", task.taskId)).rejects.toThrow("不存在");
  await f.runtime.stop("owner", task.taskId);
  expect(f.runtime.list("owner")[0].status).toBe("cancelled");
  await expect
    .poll(() => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    })
    .toBe(false);
  await f.runtime.stop("owner", task.taskId);
  await expect(f.runtime.stop("owner", task.taskId, true)).rejects.toThrow("not running");
  expect(f.port.notify).not.toHaveBeenCalled();
});

test("foreground commands return output and failures; eligible deadline hands off the same process", async () => {
  const f = await fixture();
  expect(await f.invoke({ command: "printf hello" })).toMatchObject({
    isError: false,
    content: [{ text: "hello" }],
  });
  expect(await f.invoke({ command: "echo bad >&2; exit 7" })).toMatchObject({
    isError: true,
    content: [{ text: expect.stringContaining("exit code 7") }],
  });
  expect(f.runtime.list("owner")).toHaveLength(0);
  await f.invoke({ command: "echo once; sleep 0.15; echo done", timeout: 10 });
  const task = f.runtime.list("owner")[0];
  expect(task.autoBackgrounded).toBe(true);
  const result = await f.runtime.output("owner", { task_id: task.taskId, timeout: 1000 });
  expect(result.details).toMatchObject({
    retrieval_status: "success",
    task: { output: "once\ndone\n", exitCode: 0 },
  });
  expect(f.port.notify).not.toHaveBeenCalled();
  expect(f.port.error).not.toHaveBeenCalled();
});

test("sleep deadlines and foreground cancellation terminate instead of backgrounding", async () => {
  const f = await fixture();
  expect(await f.invoke({ command: "sleep 30", timeout: 10 })).toMatchObject({ isError: true });
  const abort = new AbortController();
  const run = f.invoke({ command: "echo running; sleep 30" }, abort.signal);
  setTimeout(() => abort.abort(), 30);
  await expect(run).rejects.toThrow();
  expect(f.runtime.list("owner")).toHaveLength(0);
});

test("foreground commands publish previews and retain turn cancellation", async () => {
  const f = await fixture();
  const abort = new AbortController();
  const update = vi.fn<AgentToolUpdateCallback>(() => abort.abort());
  await expect(f.invoke({ command: "echo ready; sleep 30" }, abort.signal, f.dir, update)).rejects.toThrow();
  expect(update).toHaveBeenCalledWith({
    content: [{ type: "text", text: "ready\n" }],
    details: undefined,
    isError: false,
  });
  expect(f.runtime.list("owner")).toHaveLength(0);
  expect(f.port.error).not.toHaveBeenCalled();
});

test.each([false, true])(
  "background handoff stops turn previews with run_in_background=%s",
  async (background) => {
    const f = await fixture();
    const abort = new AbortController();
    const update = vi.fn<AgentToolUpdateCallback>();
    await f.invoke(
      { command: "echo ready; sleep 30", timeout: 10, run_in_background: background },
      abort.signal,
      f.dir,
      update,
    );
    const task = f.runtime.list("owner")[0];
    abort.abort();
    const result = await f.runtime.output("owner", { task_id: task.taskId, timeout: 1200 });
    expect(result.details.retrieval_status).toBe("timeout");
    expect(result.details.task.output).toBe("ready\n");
    await f.runtime.stop("owner", task.taskId);
    expect(update).not.toHaveBeenCalled();
    expect(f.port.error).not.toHaveBeenCalled();
  },
);

test("TaskOutput supports nonblocking reads, timed waits and aborts without stopping the task", async () => {
  const f = await fixture();
  const task = await f.launch();
  expect(
    (await f.runtime.output("owner", { task_id: task.taskId, block: false })).details.retrieval_status,
  ).toBe("not_ready");
  expect(
    (await f.runtime.output("owner", { task_id: task.taskId, timeout: 5 })).details.retrieval_status,
  ).toBe("timeout");
  const abort = new AbortController();
  const wait = f.runtime.output("owner", { task_id: task.taskId }, abort.signal);
  abort.abort();
  await expect(wait).rejects.toThrow();
  expect(f.runtime.list("owner")[0].status).toBe("running");
});

test("unclaimed completion notifies exactly once, including failed background commands", async () => {
  const f = await fixture();
  const task = await f.launch("echo failure >&2; exit 6");
  await expect.poll(() => f.port.notify.mock.calls.length).toBe(1);
  expect(f.port.notify).toHaveBeenCalledWith(expect.objectContaining({ status: "failed", exitCode: 6 }));
  const result = await f.runtime.output("owner", { task_id: task.taskId });
  expect(result.details.task.output).toBe("failure\n");
  expect(f.port.notify).toHaveBeenCalledTimes(1);
});

test("aborted output wait does not consume later completion notification", async () => {
  const f = await fixture();
  const task = await f.launch("sleep 0.15; echo done");
  const abort = new AbortController();
  const waiting = f.runtime.output("owner", { task_id: task.taskId }, abort.signal);
  abort.abort();
  await expect(waiting).rejects.toThrow();
  await expect.poll(() => f.port.notify.mock.calls.length).toBe(1);
});

test("retains descendants after their launching shell exits and stops them on shutdown", async () => {
  const f = await fixture();
  const task = await f.launch("sleep 30 & echo $!");
  await expect.poll(async () => (await f.runtime.read("owner", task.taskId)).output.trim()).toMatch(/^\d+$/);
  expect(f.runtime.list("owner")[0].status).toBe("running");
  const pid = Number((await f.runtime.read("owner", task.taskId)).output.trim());
  await f.runtime.close();
  await expect
    .poll(() => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    })
    .toBe(false);
  expect(f.runtime.list("owner")[0].status).toBe("cancelled");
});

test("large output uses running prefix and bounded UI tail, retaining a complete file", async () => {
  const f = await fixture();
  const task = await f.launch();
  await expect.poll(async () => (await f.runtime.read("owner", task.taskId)).output).toContain("ready");
  await writeFile(task.outputPath, `HEAD${"x".repeat(100000)}TAIL`);
  const preview = await f.runtime.read("owner", task.taskId);
  expect(preview.output).toHaveLength(65536);
  expect(preview.output).toMatch(/TAIL$/);
  expect(preview.truncated).toBe(true);
  const output = await f.runtime.output("owner", { task_id: task.taskId, block: false });
  expect(output.details.task.output).toMatch(/^HEAD/);
  expect(output.details.task.output).toContain("Output truncated");
  expect(output.details.task.output).not.toContain("TAIL");
  expect((await readFile(task.outputPath)).length).toBe(100008);
});

test("missing cwd is a foreground spawn failure and restored PIDs cannot be stopped", async () => {
  const f = await fixture();
  expect(
    await f.invoke({ command: "true", run_in_background: true }, undefined, join(f.dir, "missing")),
  ).toMatchObject({ isError: true });
  expect(f.runtime.list("owner")).toHaveLength(0);
  f.runtime.restore({
    taskId: "exec_old",
    sessionId: "owner",
    toolCallId: "old",
    command: "sleep 30",
    description: "Old",
    status: "running",
    pid: process.pid,
    startedAt: 1,
    outputPath: join(f.dir, "old.log"),
  });
  expect(f.runtime.list("owner")[0].status).toBe("lost");
  await f.runtime.stop("owner", "exec_old");
  expect(process.kill(process.pid, 0)).toBe(true);
});

test("stopping lets services flush cleanup output before forcefully terminating an unresponsive tree", async () => {
  const f = await fixture();
  const task = await f.launch("trap 'echo cleaned; exit 0' TERM; echo ready; while :; do sleep 1; done");
  await expect.poll(async () => (await f.runtime.read("owner", task.taskId)).output).toContain("ready");
  await f.runtime.stop("owner", task.taskId);
  expect((await f.runtime.read("owner", task.taskId)).output).toContain("cleaned");
  const stubborn = await f.launch("trap '' TERM; echo ready; while :; do sleep 1; done");
  await expect.poll(async () => (await f.runtime.read("owner", stubborn.taskId)).output).toContain("ready");
  await f.runtime.stop("owner", stubborn.taskId);
  expect(f.runtime.list("owner").at(-1)?.status).toBe("cancelled");
  expect(f.port.error).not.toHaveBeenCalled();
});

test("truncated foreground output retains the full log and gives its path", async () => {
  const f = await fixture();
  const result = await f.invoke({ command: "head -c 70000 /dev/zero | tr '\\0' x; printf END" });
  const text = result.content.map((part) => (part.type === "text" ? part.text : "")).join("");
  expect(text).toContain("END");
  const path = /Full output: (.+)\]/.exec(text)?.[1];
  if (!path) throw new Error("Missing output artifact");
  expect((await readFile(path)).length).toBe(70003);
});

test.each([70000, 8 * 1024 ** 2 + 1024])(
  "completed TaskOutput retains final errors when the log contains %i padding bytes",
  async (paddingBytes) => {
    const f = await fixture();
    const outputPath = join(f.dir, "completed.log");
    await writeFile(outputPath, `HEAD${"x".repeat(paddingBytes)}\nFINAL_ERROR: compiler failed\n`);
    f.runtime.restore({
      taskId: "exec_completed",
      sessionId: "owner",
      toolCallId: "call",
      command: "build",
      description: "Build",
      status: "failed",
      startedAt: 1,
      endedAt: 2,
      exitCode: 7,
      outputPath,
    });
    const result = await f.runtime.output("owner", { task_id: "exec_completed" });
    expect(result.details.retrieval_status).toBe("success");
    expect(result.details.task.output).not.toContain("HEAD");
    expect(result.details.task.output).toContain("FINAL_ERROR: compiler failed\n");
    expect(result.details.task.output).toContain(`Full output: ${outputPath}`);
    expect(result.details.task.output.length).toBeLessThan(33000);
    expect(result.content[0].text).toContain("FINAL_ERROR: compiler failed\n");
  },
);

// POSIX truncate extends the file with holes, so this tests the real limit without writing 5 GiB.
test.skipIf(process.platform === "win32").each([false, true])(
  "the output limit stops the process tree with run_in_background=%s",
  async (background) => {
    const f = await fixture();
    const run = f.invoke({
      command: "echo $$ > shell.pid; sleep 30 & echo $! > child.pid; wait",
      run_in_background: background,
    });
    await expect.poll(() => readFile(join(f.dir, "child.pid"), "utf8")).toMatch(/^\d+\n$/);
    const pids = await Promise.all(
      ["shell.pid", "child.pid"].map(async (name) => Number(await readFile(join(f.dir, name), "utf8"))),
    );
    const directory = join(f.dir, "agent", "tool-output", "owner");
    const [name] = await readdir(directory);
    const outputPath = join(directory, name);
    await truncate(outputPath, 5 * 1024 ** 3 + 1);
    expect((await stat(outputPath)).blocks * 512).toBeLessThan(1024 ** 2);

    if (background) {
      await run;
      await expect.poll(() => f.runtime.list("owner")[0].status, { timeout: 5000 }).toBe("failed");
      expect(f.runtime.list("owner")[0].error).toBe("Command output exceeded 5 GiB.");
    } else {
      expect(await run).toMatchObject({
        isError: true,
        content: [{ text: expect.stringContaining("Command output exceeded 5 GiB.") }],
      });
      expect(f.runtime.list("owner")).toHaveLength(0);
    }
    for (const pid of pids) {
      await expect
        .poll(() => {
          try {
            process.kill(pid, 0);
            return true;
          } catch {
            return false;
          }
        })
        .toBe(false);
    }
    expect(f.port.error).not.toHaveBeenCalled();
  },
);
