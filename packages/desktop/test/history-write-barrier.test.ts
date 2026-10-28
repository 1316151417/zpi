import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { chunk, deferred, done, send } from "../../../tests/fake-server.ts";
import type { WorkerHistoryIndex } from "../src/main/history-storage.ts";
import { fixture } from "./helpers/host-fixture.ts";

it.each([false, true])(
  "waits for the asynchronous tool journal before executing a write (failure=%s)",
  async (fail) => {
    const entered = deferred(),
      release = deferred();
    const f = await fixture((_, response, n) => {
      send(
        response,
        chunk(
          n
            ? { content: "finished" }
            : {
                tool_calls: [
                  {
                    index: 0,
                    id: "write",
                    type: "function",
                    function: {
                      name: "write",
                      arguments: JSON.stringify({ path: "result.txt", content: "durable tool" }),
                    },
                  },
                ],
              },
        ),
      );
      done(response, n ? "stop" : "tool_calls");
    });
    const task = await f.host.createSession(f.a.id);
    const index = (f.host as unknown as { indexes: Map<string, WorkerHistoryIndex> }).indexes.get(task.id);
    if (!index) throw new Error("Missing fixture index");
    const append = index.appendAsync.bind(index);
    let held = false;
    const persistence = vi.spyOn(index, "appendAsync").mockImplementation(async (entry) => {
      if (!held && entry.type === "custom" && entry.customType === "zpi.streaming_tools") {
        held = true;
        entered.resolve();
        await release.promise;
        if (fail) throw new Error("storage: journal write failed");
      }
      await append(entry);
    });
    try {
      await f.host.startRun({ sessionId: task.id, text: "write the result" });
      const run = f.host.activeRuns.get(task.id);
      if (!run) throw new Error("Missing active fixture run");
      await entered.promise;
      expect(existsSync(join(f.a.path, "result.txt"))).toBe(false);
      release.resolve();
      await run.done;
      expect(f.host.getSessionSnapshot(task.id).session.status).toBe(fail ? "error" : "completed");
      if (fail) {
        expect(existsSync(join(f.a.path, "result.txt"))).toBe(false);
        expect(f.server.requests).toHaveLength(1);
      } else {
        expect(await readFile(join(f.a.path, "result.txt"), "utf8")).toBe("durable tool");
        expect(f.server.requests).toHaveLength(2);
      }
    } finally {
      release.resolve();
      persistence.mockRestore();
    }
  },
);
