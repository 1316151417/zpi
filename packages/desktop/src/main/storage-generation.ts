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
import { syncDirectory } from "@zpi-dev/coding-agent";
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
/** SQLite releases this exclusive owner lock when the process exits. */
export function acquireStorageLock(root: string): () => void {
  mkdirSync(root, { recursive: true });
  const mutex = new DatabaseSync(join(root, ".storage-lock.sqlite"));
  try {
    mutex.exec("BEGIN IMMEDIATE");
  } catch (cause) {
    mutex.close();
    throw new Error("storage: 存储已锁定，请关闭使用此数据目录的 ZPI", { cause });
  }
  let released = false;
  return () => {
    if (!released) {
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
/** The initializer creates the new schema only; it must close/checkpoint before returning. */
export function openStorageGeneration(
  root: string,
  initialize: (directory: string) => void,
): {
  directory: string;
  marker: StorageGeneration;
  close: () => void;
} {
  const close = acquireStorageLock(root);
  try {
    const active = readActiveGeneration(root);
    if (active) return { ...active, close };
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
