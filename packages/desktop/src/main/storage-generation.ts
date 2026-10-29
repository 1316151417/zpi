import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { validateStateDatabase } from "./state-store.ts";

export interface StorageGeneration {
  format: 2;
  generationId: string;
  schemaVersion: 1;
  transcriptVersion: 2;
}
const validId = /^[a-zA-Z0-9_-]+$/;
function assertGeneration(value: unknown): asserts value is StorageGeneration {
  const item = value as StorageGeneration;
  if (
    item?.format !== 2 ||
    item.schemaVersion !== 1 ||
    item.transcriptVersion !== 2 ||
    typeof item.generationId !== "string" ||
    !validId.test(item.generationId)
  )
    throw new Error("storage: 存储版本或 generation 标识无效");
}
export function syncDirectory(path: string): void {
  // Windows does not expose directory fsync through Node's file API.
  if (process.platform === "win32") return;
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
export function durableJson(path: string, value: unknown): void {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(temporary, "wx", 0o600);
  try {
    try {
      writeFileSync(fd, `${JSON.stringify(value)}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}
/** The OS releases the SQLite lock on exit. Keep owner.json for older runtimes and migration checks. */
export function acquireStorageLock(root: string, purpose: "runtime" | "migration"): () => void {
  mkdirSync(root, { recursive: true });
  const path = join(root, ".storage-lock");
  const mutex = new DatabaseSync(join(root, ".storage-lock.sqlite"));
  const token = randomUUID();
  try {
    // Serialize stale-owner inspection/removal too; two recoverers must never remove a new owner's lock.
    mutex.exec("BEGIN EXCLUSIVE");
    try {
      mkdirSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const owner = JSON.parse(readFileSync(join(path, "owner.json"), "utf8")) as { pid?: number };
      if (!Number.isSafeInteger(owner?.pid) || !owner.pid || owner.pid < 1) throw error;
      let exited = false;
      try {
        process.kill(owner.pid, 0);
      } catch (probe) {
        // EPERM and unreadable/missing owner records are not evidence that a process has exited.
        if ((probe as NodeJS.ErrnoException).code !== "ESRCH") throw error;
        exited = true;
      }
      // A live legacy owner does not hold the SQLite mutex.
      if (!exited) throw error;
      rmSync(path, { recursive: true });
      mkdirSync(path);
    }
    try {
      durableJson(join(path, "owner.json"), {
        token,
        pid: process.pid,
        purpose,
        createdAt: new Date().toISOString(),
      });
    } catch (error) {
      rmSync(path, { recursive: true, force: true });
      throw error;
    }
  } catch (cause) {
    mutex.close();
    throw new Error(
      "storage: 存储已锁定或锁所有者无法确认。请关闭 ZPI 和迁移工具；无法验证的遗留锁需人工检查。",
      {
        cause,
      },
    );
  }
  let released = false;
  return () => {
    if (released) return;
    try {
      const owner = JSON.parse(readFileSync(join(path, "owner.json"), "utf8")) as { token?: string };
      if (owner.token !== token) throw new Error("storage: 存储锁所有者已变化");
      rmSync(path, { recursive: true });
    } finally {
      mutex.close();
      released = true;
    }
  };
}
export function generationDirectory(root: string, id: string): string {
  if (!validId.test(id)) throw new Error("storage: 无效 generation 标识");
  const base = join(resolve(root), "storage");
  if (existsSync(base) && lstatSync(base).isSymbolicLink())
    throw new Error("storage: storage 目录不能是符号链接");
  const directory = join(base, id);
  if (existsSync(directory) && lstatSync(directory).isSymbolicLink())
    throw new Error("storage: generation 不能是符号链接");
  return directory;
}
export function readActiveGeneration(
  root: string,
): { directory: string; marker: StorageGeneration } | undefined {
  const pointer = join(root, "active-generation.json");
  if (!existsSync(pointer)) return undefined;
  const marker: unknown = JSON.parse(readFileSync(pointer, "utf8"));
  assertGeneration(marker);
  const directory = generationDirectory(root, marker.generationId);
  const ready: unknown = JSON.parse(readFileSync(join(directory, "ready.json"), "utf8"));
  assertGeneration(ready);
  if (ready.generationId !== marker.generationId || !existsSync(join(directory, "state.sqlite")))
    throw new Error("storage: generation 未完整发布");
  validateStateDatabase(join(directory, "state.sqlite"));
  return { directory, marker };
}
export function activateStorageGeneration(root: string, marker: StorageGeneration): void {
  assertGeneration(marker);
  const directory = generationDirectory(root, marker.generationId);
  const ready: unknown = JSON.parse(readFileSync(join(directory, "ready.json"), "utf8"));
  assertGeneration(ready);
  if (ready.generationId !== marker.generationId || !existsSync(join(directory, "state.sqlite")))
    throw new Error("storage: 无法激活不完整的 generation");
  validateStateDatabase(join(directory, "state.sqlite"), "full");
  durableJson(join(root, "active-generation.json"), marker);
  syncDirectory(root);
}
export function hasLegacyStorage(root: string): boolean {
  if (["settings.json", "projects.json", "task-groups.json"].some((name) => existsSync(join(root, name))))
    return true;
  const sessions = join(root, "agent", "sessions");
  return existsSync(sessions) && readdirSync(sessions).length > 0;
}
/** The initializer creates the new schema only; it must close/checkpoint before returning. */
export function openStorageGeneration(
  root: string,
  initialize: (directory: string) => void,
): {
  directory: string;
  marker: StorageGeneration;
  close: () => void;
} {
  const close = acquireStorageLock(root, "runtime");
  try {
    const active = readActiveGeneration(root);
    if (active) return { ...active, close };
    if (hasLegacyStorage(root))
      throw new Error(
        "storage: 检测到旧版数据。请先退出应用，使用独立 storage-migrate 工具迁移；本版本不会自动修改或加载旧数据。",
      );
    const storageRoot = join(root, "storage");
    if (
      existsSync(storageRoot) &&
      readdirSync(storageRoot).some((name) => existsSync(join(generationDirectory(root, name), "ready.json")))
    )
      throw new Error("storage: 已有完整 generation 但缺少活动指针，请先诊断恢复，不能初始化覆盖");
    const marker: StorageGeneration = {
      format: 2,
      generationId: `fresh-${randomUUID()}`,
      schemaVersion: 1,
      transcriptVersion: 2,
    };
    const directory = generationDirectory(root, marker.generationId);
    mkdirSync(directory, { recursive: true });
    initialize(directory);
    if (!existsSync(join(directory, "state.sqlite"))) throw new Error("storage: 数据库初始化未完成");
    validateStateDatabase(join(directory, "state.sqlite"));
    durableJson(join(directory, "ready.json"), marker);
    syncDirectory(directory);
    syncDirectory(join(root, "storage"));
    activateStorageGeneration(root, marker);
    return { directory, marker, close };
  } catch (error) {
    close();
    throw error;
  }
}
