import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { emptyAssistant } from "zpi-ai";
import { SessionManager } from "zpi-coding-agent";
import { mergeHistory } from "zpi-ui";
import { fakeModel } from "../../../tests/fake-server.ts";
import { HistoryStorage } from "../src/main/history-storage.ts";
import { restoreView } from "../src/main/projection.ts";
import { StateStore } from "../src/main/state-store.ts";
import { seedHistory } from "./helpers/history-fixture.ts";

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
});
const MiB = 1024 * 1024;

it("rebuilds and pages hundreds of tool steps in one run without gaps, duplicates or extra runs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zpi-single-turn-"));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const state = new StateStore(join(dir, "state.sqlite"));
  cleanup.push(() => state.close());
  const calls = 160;
  const seed = seedHistory(state, dir, dir, calls, { perRun: calls, outputBytes: 64 * 1024 });
  const storage = new HistoryStorage(join(dir, "history.sqlite"));
  cleanup.push(() => storage.close());
  let ticks = 0;
  const timer = setInterval(() => {
    ticks++;
  }, 5);
  const index = await storage.open(seed.file).finally(() => clearInterval(timer));
  expect(ticks).toBeGreaterThan(0);
  const snapshot = index.snapshot();
  let page = index.page();
  expect(page.calls).toBe(10);
  expect(index.readBytes).toBeLessThanOrEqual(2 * MiB);
  let view = restoreView(seed.id, "", page.entries);
  expect(view.runs).toHaveLength(1);
  expect(view.runs[0].historyContinuation).toBe(true);
  let pages = 1;
  const cursors = new Set<number>();
  while (page.cursor !== null) {
    expect(cursors.has(page.cursor)).toBe(false);
    cursors.add(page.cursor);
    index.readBytes = 0;
    page = index.page(page.cursor);
    expect(page.calls).toBeLessThanOrEqual(10);
    expect(index.readBytes).toBeLessThanOrEqual(2 * MiB);
    view = mergeHistory(restoreView(seed.id, "", page.entries), view);
    expect(view.runs).toHaveLength(1);
    pages++;
  }
  expect(pages).toBeGreaterThan(10);
  const full = restoreView(
    seed.id,
    "",
    [...index.readRange(1, snapshot.endSeq, snapshot)].map(({ entry }) => entry),
  );
  expect(view.runs[0].orderedBlocks).toEqual(full.runs[0].orderedBlocks);
  expect(new Set(view.runs[0].orderedBlocks.map((block) => block.id)).size).toBe(
    view.runs[0].orderedBlocks.length,
  );
  expect(view.runs[0].userMessage).toBe("用户上下文 0");
  for (const ordinal of [0, 80, 159]) {
    expect(index.hasSearchText(`最终回复 ${ordinal}\n`)).toBe(true);
    expect([...index.searchTextFor(`最终回复 ${ordinal}\n`)]).toHaveLength(1);
  }
  const warm = await storage.open(seed.file);
  expect(warm.snapshot()).toEqual(snapshot);
  expect(restoreView(seed.id, "", warm.page().entries).runs[0].orderedBlocks).toEqual(
    restoreView(seed.id, "", index.page().entries).runs[0].orderedBlocks,
  );
});

it("lets a single oversized record occupy its own page and preserves it across rebuild and continued writes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zpi-single-record-"));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const storage = new HistoryStorage(join(dir, "history.sqlite"));
  cleanup.push(() => storage.close());
  const index = await storage.open(join(dir, "large.jsonl"), undefined, {
    type: "session",
    format: "zpi",
    version: 2,
    id: "large",
    cwd: dir,
    timestamp: new Date().toISOString(),
  });
  const manager = SessionManager.fromStore(index);
  await manager.appendCustomEntryAsync("zpi.run", { phase: "start", runId: "one", text: "one long turn" });
  const assistant = emptyAssistant(fakeModel(""));
  const text = `BEGIN\n${"长结果\n".repeat(300000)}END`;
  await manager.appendMessageAsync({ ...assistant, content: [{ type: "text", text }] });
  index.readBytes = 0;
  const page = index.page();
  expect(index.readBytes).toBeGreaterThan(2 * MiB);
  expect(index.readBytes).toBeLessThan(8 * MiB);
  expect(page.entries.filter((entry) => entry.type === "message")).toHaveLength(1);
  expect(restoreView("large", "", page.entries).runs).toHaveLength(1);
  await manager.appendMessageAsync({ ...assistant, content: [{ type: "text", text: "after large result" }] });
  const reopened = await storage.open(index.path);
  const context = SessionManager.fromStore(reopened).buildSessionContext();
  expect(context.messages).toMatchObject([
    { role: "assistant", content: [{ type: "text", text }] },
    { role: "assistant", content: [{ type: "text", text: "after large result" }] },
  ]);
  const before = index.snapshot(),
    bytes = (await stat(index.path)).size;
  await expect(
    manager.appendMessageAsync({
      ...assistant,
      content: [{ type: "text", text: "x".repeat(8 * MiB) }],
    }),
  ).rejects.toThrow("8 MiB");
  expect(index.snapshot()).toEqual(before);
  expect((await stat(index.path)).size).toBe(bytes);
});
