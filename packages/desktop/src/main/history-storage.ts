import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";
import type { SessionEntry, SessionHeader } from "zpi-coding-agent";
import { type GenerationHooks, HistoryIndex, type HistoryMetadata } from "./history-index.ts";
import type { HistoryCommand } from "./history-worker.ts";

/** Owns the only history writer. The main process uses a separate read-only cache connection. */
export class HistoryStorage {
  private worker?: Worker;
  private reader?: DatabaseSync;
  private starting?: Promise<void>;
  private closed = false;
  private sequence = 0;
  private pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  private readonly database: string;
  constructor(database: string) {
    this.database = database;
  }
  start(): Promise<void> {
    this.starting ??= (async () => {
      this.worker = new Worker(
        new URL(
          import.meta.url.endsWith(".ts") ? "./history-worker.ts" : "./history-worker.js",
          import.meta.url,
        ),
        { workerData: { database: this.database } },
      );
      this.worker.on("message", (message: { id: number; result?: unknown; error?: string }) => {
        const job = this.pending.get(message.id);
        if (!job) return;
        this.pending.delete(message.id);
        if (message.error) job.reject(new Error(message.error));
        else job.resolve(message.result);
      });
      const fail = (error: Error) => {
        this.closed = true;
        for (const job of this.pending.values()) job.reject(error);
        this.pending.clear();
      };
      this.worker.on("error", fail);
      this.worker.on("exit", (code) => fail(new Error(`storage: History worker exited (${code})`)));
      await this.request<void>({ type: "init" });
      this.reader = new DatabaseSync(this.database, { readOnly: true });
    })();
    return this.starting;
  }
  request<T = HistoryMetadata>(command: HistoryCommand): Promise<T> {
    if (!this.worker || (this.closed && command.type !== "close"))
      return Promise.reject(new Error("storage: History worker is unavailable"));
    return new Promise<T>((resolve, reject) => {
      const id = ++this.sequence;
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject });
      try {
        this.worker?.postMessage({ id, command });
      } catch (error) {
        this.pending.delete(id);
        reject(error);
      }
    });
  }
  async open(path: string, hooks?: GenerationHooks, header?: SessionHeader): Promise<WorkerHistoryIndex> {
    await this.start();
    const metadata = await this.request(header ? { type: "create", path, header } : { type: "load", path });
    if (!this.reader) throw new Error("storage: Missing history reader");
    return new WorkerHistoryIndex(metadata, this.reader, this, hooks);
  }
  async forget(path: string): Promise<void> {
    await this.request<void>({ type: "forget", path });
  }
  async forgetTask(taskId: string): Promise<void> {
    await this.request<void>({ type: "forget-task", taskId });
  }
  async close(): Promise<void> {
    if (!this.starting) return;
    try {
      await this.starting;
      if (!this.closed) {
        this.closed = true;
        await this.request<void>({ type: "close" });
      }
    } finally {
      this.reader?.close();
      await this.worker?.terminate();
      this.reader = undefined;
      this.worker = undefined;
    }
  }
}

export class WorkerHistoryIndex extends HistoryIndex {
  private readonly storage: HistoryStorage;
  private readonly hooks?: GenerationHooks;
  constructor(metadata: HistoryMetadata, db: DatabaseSync, storage: HistoryStorage, hooks?: GenerationHooks) {
    super(metadata.path, db, undefined, true);
    this.storage = storage;
    this.hooks = hooks;
    this.adoptMetadata(metadata);
  }
  override append(): never {
    throw new Error("storage: History writes must be awaited");
  }
  override replace(): never {
    throw new Error("storage: History replacement must be awaited");
  }
  override async load(): Promise<void> {
    this.adoptMetadata(await this.storage.request({ type: "load", path: this.path }));
  }
  override async flush(): Promise<void> {
    this.adoptMetadata(await this.storage.request({ type: "flush", path: this.path }));
  }
  async appendAsync(entry: SessionEntry): Promise<void> {
    this.adoptMetadata(await this.storage.request({ type: "append", path: this.path, entry }));
  }
  async replaceAsync(
    header: SessionHeader,
    entries: Iterable<SessionEntry>,
    options?: { remapIds?: boolean },
  ): Promise<void> {
    const token = randomUUID();
    const path = join(dirname(this.path), `${header.id}.generation-${randomUUID()}.jsonl`);
    this.hooks?.prepare(this.path, path, header);
    let metadata: HistoryMetadata;
    try {
      await this.storage.request<void>({
        type: "stage-start",
        token,
        path,
        header,
        remapIds: options?.remapIds,
      });
      // One acknowledged record at a time bounds queued structured clones and spool memory.
      for (const entry of entries) await this.storage.request<void>({ type: "stage-entry", token, entry });
      metadata = await this.storage.request({ type: "stage-finish", token });
    } catch (error) {
      await this.storage.request<void>({ type: "stage-cancel", token }).catch(() => {});
      throw error;
    } finally {
      // Worker exit cannot acknowledge cancellation; reclaim its owned spool here too.
      await rm(`${path}.${token}.entries.tmp`, { force: true });
    }
    this.hooks?.commit(this.path, path, metadata.data.header, metadata.data.size);
    this.adoptMetadata(metadata);
  }
}
