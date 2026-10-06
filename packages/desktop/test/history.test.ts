import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { seedHistory } from "../../../tests/history-fixture.ts";
import { HistoryIndex } from "../src/main/history-index.ts";
import { SessionHost } from "../src/main/session-host.ts";
import { cleanup, idle, setup } from "./helpers/session-fixture.ts";

it("legacy transcripts rebuild old indexes and retain run metadata and paged history", async () => {
  const { host, dir, cwd } = await setup();
  const seed = seedHistory(dir, cwd, 2, { perRun: 2 });
  await host.close();
  const before = new HistoryIndex(seed.file);
  await before.load();
  const original = await readFile(seed.file, "utf8");
  const legacy = original.replaceAll("ZPI", "ZPI".toLowerCase());
  await writeFile(seed.file, legacy);
  const { stat } = await import("node:fs/promises");
  const fileStat = await stat(seed.file);
  await writeFile(
    `${seed.file}.index.json`,
    JSON.stringify({ ...before.data, version: 5, size: fileStat.size, modified: fileStat.mtimeMs }),
  );
  const restored = new HistoryIndex(seed.file);
  await restored.load();
  expect(restored.readBytes).toBeGreaterThan(0);
  expect(restored.data.header.format).toBe("ZPI");
  expect(restored.data.diagnostic).toBeUndefined();
  expect(restored.data.state["ZPI.session_meta"]).toMatchObject({ customType: "ZPI.session_meta" });
  expect(restored.data.calls).toHaveLength(2);
  expect(restored.page().entries).toEqual(before.page().entries);
  expect(await readFile(seed.file, "utf8")).toBe(legacy);
});

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
