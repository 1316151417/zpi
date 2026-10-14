/** Opt-in large-fixture benchmark. Run: node --import tsx scripts/benchmark-lazy-restore.ts [100,1024] [repetitions]
 * Fixtures live in a temporary workspace directory and are removed after each case.
 * Uses real SQLite and JSONL; fresh processes, warm OS cache, no model/network/GUI.
 */

import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { cpus, platform, release, totalmem } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import { type SessionEntry, SessionManager } from "zpi-coding-agent";
import { HistoryIndex } from "../packages/desktop/src/main/history-index.ts";
import { encodeTranscriptEntry } from "../packages/desktop/src/main/transcript-v2.ts";

const MiB = 1024 * 1024;
const script = resolve("scripts/benchmark-lazy-restore.ts");
const stamp = "2026-10-14T00:00:00.000Z";
function database(dir: string) {
  const db = new DatabaseSync(join(dir, "state.sqlite"));
  db.exec(
    "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000",
  );
  return db;
}
function fixture(dir: string, sizeMiB: number, compressed: boolean) {
  const path = join(dir, "session.jsonl");
  const fd = openSync(path, "wx");
  let seq = 0;
  let bytes = 0;
  let parentId: string | null = null;
  const write = (value: unknown) => {
    const line = `${JSON.stringify(value)}\n`;
    bytes += Buffer.byteLength(line);
    writeSync(fd, line);
  };
  write({
    type: "session",
    version: 2,
    format: "zpi",
    generation: randomUUID(),
    id: "benchmark",
    cwd: dir,
    timestamp: stamp,
  });
  const append = (fields: object) => {
    const id = `entry-${++seq}`;
    write(encodeTranscriptEntry({ ...fields, id, parentId, timestamp: stamp } as SessionEntry, seq));
    parentId = id;
    return id;
  };
  const payload = "x".repeat(64 * 1024);
  let messageCount = 0;
  const message = () => {
    messageCount++;
    return append({ type: "message", message: { role: "user", content: payload, timestamp: 0 } });
  };
  while (bytes < sizeMiB * MiB - (compressed ? 5 * MiB : 0)) message();
  let keptSeq: number | undefined;
  let compactionSeq: number | undefined;
  if (compressed) {
    const kept = message();
    keptSeq = seq;
    for (let i = 1; i < 40; i++) message();
    append({
      type: "compaction",
      summary: "Fixed summary",
      firstKeptEntryId: kept,
      systemMessage: { role: "system", content: "Fixed instructions", timestamp: 0 },
    });
    compactionSeq = seq;
    for (let i = 0; i < 40; i++) message();
  }
  fsyncSync(fd);
  closeSync(fd);
  const manifest = {
    sizeMiB,
    compressed,
    fileBytes: bytes,
    entryCount: seq,
    messageCount,
    expectedContextMessages: compressed ? 82 : messageCount,
    expectedPayloadBytes: compressed ? 5 * MiB : messageCount * payload.length,
    keptSeq,
    compactionSeq,
  };
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest));
  return manifest;
}
async function worker(dir: string, mode: string) {
  const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
  const db = database(dir);
  if (mode === "rebuild") {
    for (const { name } of db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'transcript_%'")
      .all())
      db.exec(`DROP TABLE ${name}`);
  }
  global.gc?.();
  const before = process.memoryUsage();
  let parsedEntries = 0;
  const parse = JSON.parse;
  JSON.parse = (text, reviver) => {
    const value = parse(text, reviver);
    if (
      value &&
      typeof value === "object" &&
      Number.isSafeInteger(value.seq) &&
      typeof value.type === "string"
    )
      parsedEntries++;
    return value;
  };
  const start = performance.now();
  const index = new HistoryIndex(join(dir, "session.jsonl"), db);
  await index.load();
  const manager = await SessionManager.openAsync(index);
  const openMs = performance.now() - start;
  const openReadBytes = index.readBytes;
  const afterOpen = process.memoryUsage();
  const openParsedEntries = parsedEntries;
  let materializeMs = 0;
  let contextMessages = 0;
  let payloadBytes = 0;
  if (mode === "context") {
    const begin = performance.now();
    const context = await manager.materializeContext();
    materializeMs = performance.now() - begin;
    contextMessages = context.messages.length;
    for (const message of context.messages)
      if (message.role === "user" && typeof message.content === "string" && message.content.startsWith("xxx"))
        payloadBytes += message.content.length;
    if (
      contextMessages !== manifest.expectedContextMessages ||
      payloadBytes !== manifest.expectedPayloadBytes
    )
      throw new Error("Context truncation or fixture mismatch");
  }
  const after = process.memoryUsage();
  const result = {
    mode,
    openParsedEntries,
    contextParsedEntries: parsedEntries - openParsedEntries,
    openMs,
    materializeMs,
    openReadBytes,
    contextReadBytes: index.readBytes - openReadBytes,
    contextMessages,
    payloadBytes,
    before,
    afterOpen,
    after,
    processPeakRssBytes: process.resourceUsage().maxRSS * 1024,
    sqliteBytes: statSync(join(dir, "state.sqlite")).size,
  };
  db.close();
  console.log(JSON.stringify(result));
}
if (process.argv[2] === "--worker") {
  await worker(process.argv[3], process.argv[4]);
} else {
  const sizes = (process.argv[2] ?? "100,1024").split(",").map(Number);
  const repetitions = Number(process.argv[3] ?? 1);
  if (sizes.some((n) => !Number.isInteger(n) || n < 8) || !Number.isInteger(repetitions) || repetitions < 1)
    throw new Error("Expected MiB sizes >=8 and positive repetitions");
  const base = resolve(".benchmark-tmp");
  mkdirSync(base, { recursive: true });
  console.log(
    JSON.stringify({
      environment: {
        node: process.version,
        os: `${platform()} ${release()}`,
        cpu: cpus()[0]?.model,
        logicalCpus: cpus().length,
        totalMemoryBytes: totalmem(),
        repetitions,
        cache: "OS cache not flushed; warm-index measurements run after rebuild",
        memory: "Endpoint memoryUsage and process lifetime maxRSS, not sampled per-phase peaks",
      },
    }),
  );
  try {
    for (const size of sizes)
      for (const compressed of [true, false]) {
        const dir = mkdtempSync(join(base, "restore-"));
        try {
          const manifest = fixture(dir, size, compressed);
          const measurements: object[] = [];
          for (const mode of [
            "rebuild",
            ...Array.from({ length: repetitions }, () => ["open", "context"]).flat(),
          ]) {
            const child = spawnSync(
              process.execPath,
              ["--expose-gc", "--max-old-space-size=4096", "--import", "tsx", script, "--worker", dir, mode],
              { encoding: "utf8", maxBuffer: MiB },
            );
            if (child.status !== 0) throw new Error(`${mode} failed: ${child.stderr}\n${child.stdout}`);
            measurements.push(JSON.parse(child.stdout.trim().split("\n").at(-1) ?? ""));
          }
          const result = { manifest, measurements };
          console.log(JSON.stringify(result));
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      }
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}
