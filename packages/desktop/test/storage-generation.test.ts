import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, test, vi } from "vitest";
import { StateStore } from "../src/main/state-store.ts";
import {
  acquireStorageLock,
  openStorageGeneration,
  readActiveGeneration,
} from "../src/main/storage-generation.ts";

const roots: string[] = [];
function root() {
  const path = mkdtempSync(join(tmpdir(), "zpi-generation-"));
  roots.push(path);
  return path;
}
function initialize(path: string) {
  new StateStore(join(path, "state.sqlite")).close();
}
afterEach(() => {
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});
test("fresh generation publishes once and reopens the exact authoritative database", () => {
  const dir = root();
  const first = openStorageGeneration(dir, initialize);
  const db = new StateStore(join(first.directory, "state.sqlite"));
  db.setSetting("example", { value: 42 });
  db.close();
  first.close();
  const second = openStorageGeneration(dir, () => {
    throw new Error("must not initialize twice");
  });
  expect(second.marker.generationId).toBe(first.marker.generationId);
  const reopened = new StateStore(join(second.directory, "state.sqlite"));
  expect(reopened.getSetting("example")).toEqual({ value: 42 });
  reopened.close();
  second.close();
});

test("failed initialization never publishes or falls back to an unready directory", () => {
  const dir = root();
  expect(() =>
    openStorageGeneration(dir, () => {
      throw new Error("injected failure");
    }),
  ).toThrow("injected failure");
  expect(readActiveGeneration(dir)).toBeUndefined();
  const result = openStorageGeneration(dir, initialize);
  result.close();
});
test("one runtime owns the data directory at a time", () => {
  const dir = root();
  const release = acquireStorageLock(dir);
  expect(() => openStorageGeneration(dir, initialize)).toThrow("存储已锁定");
  release();
  release();
  const result = openStorageGeneration(dir, initialize);
  result.close();
});

test("allows mutex readers while excluding another storage owner", () => {
  const dir = root();
  const reader = new DatabaseSync(join(dir, ".storage-lock.sqlite"));
  try {
    reader.exec("BEGIN; SELECT count(*) FROM sqlite_master");
    const release = acquireStorageLock(dir);
    try {
      expect(() => acquireStorageLock(dir)).toThrow("存储已锁定");
    } finally {
      release();
    }
  } finally {
    reader.close();
  }
});

test("reopens the same generation after a lock owner exits without cleanup", () => {
  const dir = root();
  const first = openStorageGeneration(dir, initialize);
  first.close();
  const source = new URL("../src/main/storage-generation.ts", import.meta.url).href;
  const child = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import { acquireStorageLock } from ${JSON.stringify(source)};
     acquireStorageLock(process.argv[1]); process.exit(0);`,
      dir,
    ],
    { timeout: 5000, encoding: "utf8" },
  );
  expect(child.status, child.stderr).toBe(0);
  expect(existsSync(join(dir, ".storage-lock", "owner.json"))).toBe(false);
  const reopened = openStorageGeneration(dir, () => {
    throw new Error("must preserve the generation");
  });
  expect(reopened.marker).toEqual(first.marker);
  reopened.close();
});

test("only one process can recover and hold an abandoned lock", async () => {
  const dir = root();
  const source = new URL("../src/main/storage-generation.ts", import.meta.url).href;
  const abandoned = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import { acquireStorageLock } from ${JSON.stringify(source)};
     acquireStorageLock(process.argv[1]); process.exit(0);`,
      dir,
    ],
    { timeout: 5000, encoding: "utf8" },
  );
  expect(abandoned.status, abandoned.stderr).toBe(0);
  const children = Array.from({ length: 2 }, () =>
    spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import { acquireStorageLock } from ${JSON.stringify(source)};
     process.once("message", () => {
       try { acquireStorageLock(process.argv[1]); process.send({ acquired: true }); }
       catch (error) {
         process.send({ acquired: false, error: error.message,
           cause: error.cause?.message, code: error.cause?.code, errcode: error.cause?.errcode });
       }
     }); process.send("ready"); setInterval(() => {}, 1000);`,
        dir,
      ],
      { stdio: ["ignore", "ignore", "pipe", "ipc"] },
    ),
  );
  const exited = children.map((child) => once(child, "exit"));
  try {
    await Promise.all(children.map((child) => once(child, "message")));
    const results = children.map((child) => once(child, "message"));
    for (const child of children) child.send("go");
    const outcomes = (await Promise.all(results)).map(([result]) => result);
    expect(outcomes.map((result) => result.acquired).sort(), JSON.stringify(outcomes)).toEqual([false, true]);
    expect(() => acquireStorageLock(dir)).toThrow("存储已锁定");
  } finally {
    for (const child of children) child.kill("SIGKILL");
    await Promise.all(exited);
  }
  const release = acquireStorageLock(dir);
  release();
});
test("bad pointer and missing database fail closed rather than recreating user state", () => {
  const dir = root();
  writeFileSync(
    join(dir, "active-generation.json"),
    JSON.stringify({ format: 2, generationId: "../../outside", schemaVersion: 1, transcriptVersion: 2 }),
  );
  expect(() => readActiveGeneration(dir)).toThrow("标识无效");
  const marker = { format: 2, generationId: "incomplete", schemaVersion: 1, transcriptVersion: 2 };
  mkdirSync(join(dir, "storage", "incomplete"), { recursive: true });
  writeFileSync(join(dir, "storage", "incomplete", "ready.json"), JSON.stringify(marker));
  writeFileSync(join(dir, "active-generation.json"), JSON.stringify(marker));
  expect(() => openStorageGeneration(dir, initialize)).toThrow("未完整发布");
});

test("never publishes an empty or partial initialized database and releases its lock", () => {
  const dir = root();
  expect(() => openStorageGeneration(dir, (path) => writeFileSync(join(path, "state.sqlite"), ""))).toThrow(
    "unsupported schema version",
  );
  expect(existsSync(join(dir, "active-generation.json"))).toBe(false);
  expect(existsSync(join(dir, ".storage-lock"))).toBe(false);
});
test("refuses a truncated active database without repair or leaving a lock", () => {
  const dir = root();
  const generation = openStorageGeneration(dir, initialize);
  generation.close();
  const file = join(generation.directory, "state.sqlite");
  writeFileSync(file, "");
  expect(() => openStorageGeneration(dir, initialize)).toThrow("unsupported schema version");
  expect(readFileSync(file)).toHaveLength(0);
  expect(existsSync(join(dir, ".storage-lock"))).toBe(false);
});
test("does not replace existing published state when its active pointer is lost", () => {
  const dir = root();
  const generation = openStorageGeneration(dir, initialize);
  generation.close();
  rmSync(join(dir, "active-generation.json"));
  expect(() => openStorageGeneration(dir, initialize)).toThrow("缺少活动指针");
  expect(existsSync(join(generation.directory, "state.sqlite"))).toBe(true);
  expect(existsSync(join(dir, ".storage-lock"))).toBe(false);
});

test("reopens an active generation without scanning all database pages", () => {
  const dir = root();
  const initial = openStorageGeneration(dir, initialize);
  initial.close();
  const prepare = vi.spyOn(DatabaseSync.prototype, "prepare");
  try {
    const reopened = openStorageGeneration(dir, initialize);
    const state = new StateStore(join(reopened.directory, "state.sqlite"));
    state.close();
    reopened.close();
    expect(
      prepare.mock.calls
        .map(([sql]) => sql)
        .filter((sql) => /(?:integrity_check|quick_check|foreign_key_check)/i.test(sql)),
    ).toEqual([]);
  } finally {
    prepare.mockRestore();
  }
});
