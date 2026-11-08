import { expect, test } from "vitest";
import { Tasks } from "../src/tasks.ts";

test("closing waits for active work and releases completed task output", async () => {
  const tasks = new Tasks();
  let stopped = false;
  const id = tasks.start(async (signal) => {
    await new Promise<void>((resolve) => {
      if (signal.aborted) resolve();
      else signal.addEventListener("abort", () => resolve(), { once: true });
    });
    stopped = true;
    return "large result";
  });
  const output = tasks.tools().find((tool) => tool.name === "TaskOutput");
  if (!output) throw new Error("TaskOutput tool is missing");
  await tasks.close();
  expect(stopped).toBe(true);
  await expect(
    output.execute("read", { task_id: id }, undefined, undefined, undefined as never),
  ).rejects.toThrow("Unknown task_id");
  await tasks.close();
});

test("API and tool stops share cancellation, retain completed output and emit one terminal event", async () => {
  const events: import("../src/tasks.ts").TaskEvent[] = [];
  const tasks = new Tasks((event) => events.push(event));
  const id = tasks.start(
    async (signal, progress) => {
      progress("working", 12, 1);
      if (!signal.aborted)
        await new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve(), { once: true }),
        );
      return "stopped output";
    },
    { toolUseId: "call", description: "work" },
  );
  await Promise.resolve();
  await Promise.all([
    tasks.stop(id),
    tasks.tools()[1].execute("stop", { task_id: id }, undefined, undefined, undefined as never),
  ]);
  await tasks.stop(id);
  expect(events.map((e) => e.phase)).toEqual(["started", "progress", "terminal"]);
  expect(events[2]).toMatchObject({ id, status: "stopped", toolUseId: "call", output: "stopped output" });
  expect(
    JSON.stringify(
      await tasks
        .tools()[0]
        .execute("read", { task_id: id, block: false }, undefined, undefined, undefined as never),
    ),
  ).toContain("stopped output");
  await expect(tasks.stop("other-owner-task")).rejects.toThrow("Unknown task_id");
  await tasks.close();
  await expect(tasks.stop(id)).rejects.toThrow("closed");
});

test("cancelled stop cannot affect a running task; failures have one terminal", async () => {
  const events: import("../src/tasks.ts").TaskEvent[] = [];
  const tasks = new Tasks((e) => events.push(e));
  let release!: () => void;
  const id = tasks.start(async (signal) => {
    await new Promise<void>((r) => (release = r));
    signal.throwIfAborted();
    throw new Error("failed intentionally");
  });
  await Promise.resolve();
  const controller = new AbortController();
  controller.abort();
  await expect(tasks.stop(id, controller.signal)).rejects.toThrow();
  release();
  const output = await tasks
    .tools()[0]
    .execute("read", { task_id: id }, undefined, undefined, undefined as never);
  expect(JSON.stringify(output)).toContain("failed intentionally");
  expect(events.filter((e) => e.phase === "terminal")).toMatchObject([{ status: "failed" }]);
  await tasks.stop(id);
  await tasks.close();
});
