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
