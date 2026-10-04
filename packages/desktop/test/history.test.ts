import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { seedHistory } from "../../../tests/history-fixture.ts";
import { HistoryIndex } from "../src/main/history-index.ts";
import { SessionHost } from "../src/main/session-host.ts";
import { cleanup, idle, setup } from "./helpers/session-fixture.ts";

it("page counts Agent pairs, includes interrupted invocation, and keeps continuation anchor without reducing model history", async () => {
  const { host, dir, cwd, settings, server } = await setup();
  const seed = seedHistory(dir, cwd, 26, { perRun: 13, interrupted: true, outputBytes: 2048 });
  await host.close();
  const reopened = new SessionHost(dir, settings, join(dir, "resources"), cwd, undefined, []);
  await reopened.init();
  cleanup.push(() => reopened.close());
  const snapshot = reopened.getSessionSnapshot(seed.id);
  expect(snapshot.historyCursor).toBe(15); // ten completed calls plus the incomplete one
  expect(snapshot.view.runs).toHaveLength(1); // eleven calls can belong to one Desktop run
  expect(snapshot.view.runs[0].userMessage).toBe("用户上下文 13");
  expect(snapshot.view.runs[0].orderedBlocks.filter((b) => b.type === "tool")).toHaveLength(11);
  expect(snapshot.view.runs[0].status).toBe("interrupted");
  const older = reopened.getHistoryPage(seed.id, 15);
  expect(older.calls).toBe(10);
  expect(older.cursor).toBe(5);
  expect(older.view.runs.map((r) => r.userMessage)).toEqual(["用户上下文 0", "用户上下文 13"]);
  expect(older.view.runs.flatMap((r) => r.orderedBlocks).filter((b) => b.type === "tool")).toHaveLength(10);
  const index = new HistoryIndex(seed.file);
  await index.load();
  expect(index.readBytes).toBe(0);
  index.page();
  expect(index.readBytes).toBeLessThan((await readFile(seed.file)).byteLength / 2);
  await reopened.startRun({ sessionId: seed.id, text: "模型上下文仍然完整" });
  await idle(reopened, seed.id);
  expect(((server.requests.at(-1)?.messages ?? []) as unknown[]).length).toBeGreaterThan(26 * 3);
});
