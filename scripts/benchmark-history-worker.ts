/** Opt-in single-run benchmark: node --import tsx scripts/benchmark-history-worker.ts [MiB=100].
 * Real JSONL/SQLite, warm OS cache, no Electron, network or model credentials. */
import { randomUUID } from "node:crypto";
import { closeSync, fsyncSync, mkdtempSync, openSync, rmSync, statSync, writeSync } from "node:fs";
import { cpus, platform, release, tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { emptyAssistant } from "zpi-ai";
import { type SessionEntry, SessionManager } from "zpi-coding-agent";
import { HistoryIndex } from "../packages/desktop/src/main/history-index.ts";
import { HistoryStorage } from "../packages/desktop/src/main/history-storage.ts";
import { restoreView } from "../packages/desktop/src/main/projection.ts";
import { encodeTranscriptEntry } from "../packages/desktop/src/main/transcript-v2.ts";
import { fakeModel } from "../tests/fake-server.ts";

const MiB = 1024 * 1024;
const sizeMiB = Number(process.argv[2] ?? 100);
if (!Number.isInteger(sizeMiB) || sizeMiB < 8) throw new Error("Expected integer MiB >= 8");
const dir = mkdtempSync(join(tmpdir(), "zpi-worker-benchmark-"));
const path = join(dir, "benchmark.jsonl");
const storage = new HistoryStorage(join(dir, "history.sqlite"));
const baselineDb = new DatabaseSync(join(dir, "baseline.sqlite"));
baselineDb.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL");
async function measure<T>(phase: string, work: () => T | Promise<T>) {
  const start = performance.now();
  let last = start,
    maxTimerGapMs = 0,
    ticks = 0;
  const timer = setInterval(() => {
    const now = performance.now();
    maxTimerGapMs = Math.max(maxTimerGapMs, now - last);
    last = now;
    ticks++;
  }, 5);
  try {
    const value = await work();
    const elapsedMs = performance.now() - start;
    await delay(10);
    console.log(
      JSON.stringify({ phase, elapsedMs, maxTimerGapMs, ticks, rssMiB: process.memoryUsage().rss / MiB }),
    );
    return value;
  } finally {
    clearInterval(timer);
  }
}
try {
  let seq = 0,
    parentId: string | null = null,
    bytes = 0,
    calls = 0;
  const fd = openSync(path, "wx", 0o600);
  const write = (value: unknown) => {
    const line = Buffer.from(`${JSON.stringify(value)}\n`);
    let offset = 0;
    while (offset < line.length) offset += writeSync(fd, line, offset);
    bytes += line.length;
  };
  const append = (fields: object) => {
    const id = `entry-${++seq}`;
    write(
      encodeTranscriptEntry(
        { ...fields, id, parentId, timestamp: new Date(0).toISOString() } as SessionEntry,
        seq,
      ),
    );
    parentId = id;
  };
  try {
    write({
      type: "session",
      version: 2,
      format: "zpi",
      id: "benchmark",
      cwd: dir,
      generation: randomUUID(),
      timestamp: new Date(0).toISOString(),
    });
    append({
      type: "custom",
      customType: "zpi.run",
      data: { phase: "start", runId: "one", text: "One very long turn", agentBoundaries: true },
    });
    append({ type: "message", message: { role: "user", content: "Inspect all files", timestamp: 0 } });
    const assistant = emptyAssistant(fakeModel(""));
    while (bytes < sizeMiB * MiB) {
      const toolId = `tool-${calls}`;
      append({
        type: "custom",
        customType: "zpi.agent_call",
        data: { phase: "start", ordinal: calls * 2 + 1 },
      });
      append({
        type: "message",
        message: {
          ...assistant,
          stopReason: "toolUse",
          content: [{ type: "toolCall", id: toolId, name: "read", arguments: { path: "README.md" } }],
        },
      });
      append({
        type: "message",
        message: {
          role: "toolResult",
          toolCallId: toolId,
          toolName: "read",
          content: [{ type: "text", text: "x".repeat(64 * 1024) }],
          isError: false,
          timestamp: 0,
        },
      });
      append({ type: "custom", customType: "zpi.agent_call", data: { phase: "end" } });
      calls++;
    }
    append({
      type: "custom",
      customType: "zpi.run",
      data: { phase: "end", runId: "one", status: "completed" },
    });
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  console.log(
    JSON.stringify({
      environment: { node: process.version, os: `${platform()} ${release()}`, cpu: cpus()[0]?.model },
      sizeMiB: statSync(path).size / MiB,
      entries: seq,
      toolCalls: calls,
      runs: 1,
      cache: "warm OS cache; baseline precedes worker; one sample per phase",
    }),
  );
  const baseline = await measure("main-thread-cold-rebuild", async () => {
    const index = new HistoryIndex(path, baselineDb);
    await index.load();
    return index;
  });
  await measure("main-thread-bulk-replace", () => {
    const manager = SessionManager.fromStore(baseline);
    manager.replaceEntries(manager.iterateEntries());
  });
  const index = await measure("worker-cold-rebuild", () => storage.open(path));
  await measure("worker-warm-open-and-first-page", async () => {
    const warm = await storage.open(path);
    const page = warm.page();
    const view = restoreView("benchmark", "", page.entries);
    if (view.runs.length !== 1 || page.calls !== 10 || warm.readBytes > 2 * MiB)
      throw new Error("Invalid bounded first page");
    console.log(
      JSON.stringify({
        firstPageBytes: warm.readBytes,
        firstPageCalls: page.calls,
        firstPageBlocks: view.runs[0].orderedBlocks.length,
      }),
    );
  });
  await measure("worker-bulk-replace", async () => {
    const manager = SessionManager.fromStore(index);
    await manager.replaceEntriesAsync(manager.iterateEntries());
    if (index.snapshot().endSeq !== seq) throw new Error("Replacement lost entries");
  });
} finally {
  await storage.close();
  baselineDb.close();
  rmSync(dir, { recursive: true, force: true });
}
