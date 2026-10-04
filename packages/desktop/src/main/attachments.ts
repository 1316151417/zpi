import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type ImageAttachment, imageLimits, processImage } from "zpi-coding-agent";
import { atomicJson } from "./storage.ts";

interface Saved extends ImageAttachment {
  used: boolean;
  queued?: boolean;
}
export class AttachmentStore {
  private root: string;
  constructor(root: string) {
    this.root = root;
  }
  private directory(sessionId: string) {
    if (!/^[a-zA-Z0-9_-]+$/.test(sessionId)) throw new Error("invalid_input: 无效会话 ID");
    return join(this.root, sessionId);
  }
  private async list(sessionId: string): Promise<Saved[]> {
    try {
      return JSON.parse(await readFile(join(this.directory(sessionId), "index.json"), "utf8"));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw e;
    }
  }
  private operations = new Map<string, Promise<unknown>>();
  private serial<T>(id: string, action: () => Promise<T>): Promise<T> {
    const result = (this.operations.get(id) ?? Promise.resolve()).catch(() => {}).then(action);
    this.operations.set(id, result);
    void result
      .finally(() => {
        if (this.operations.get(id) === result) this.operations.delete(id);
      })
      .catch(() => {});
    return result;
  }
  async cleanUnsent(): Promise<void> {
    await mkdir(this.root, { recursive: true });
    for (const dir of await readdir(this.root, { withFileTypes: true })) {
      if (!dir.isDirectory()) continue;
      for (const item of await this.list(dir.name))
        if (!item.used && !item.queued) await this.remove(dir.name, item.id);
      const keep = new Set((await this.list(dir.name)).map((item) => `${item.id}.png`));
      for (const file of await readdir(this.directory(dir.name)))
        if (file.endsWith(".png") && !keep.has(file))
          await rm(join(this.directory(dir.name), file), { force: true });
    }
  }
  async import(sessionId: string, name: string, bytes: Uint8Array): Promise<ImageAttachment> {
    if (
      typeof name !== "string" ||
      name.length > 250 ||
      !name ||
      !(bytes instanceof Uint8Array) ||
      bytes.length > imageLimits.sourceBytes
    )
      throw new Error("invalid_input: 图片导入参数无效（单张最多 10 MiB）");
    return this.serial(sessionId, async () => {
      const processed = await processImage(bytes);
      const entries = await this.list(sessionId);
      if (entries.filter((e) => !e.used && !e.queued).length >= imageLimits.count)
        throw new Error("invalid_input: 每个草稿最多 8 张图片");
      const item: Saved = {
        id: randomUUID(),
        name,
        mimeType: "image/png",
        width: processed.width,
        height: processed.height,
        size: processed.bytes.length,
        used: false,
        ...(processed.warning ? { warning: processed.warning } : {}),
      };
      await mkdir(this.directory(sessionId), { recursive: true });
      await writeFile(join(this.directory(sessionId), `${item.id}.png`), processed.bytes, { mode: 0o600 });
      try {
        atomicJson(join(this.directory(sessionId), "index.json"), [...entries, item]);
      } catch (e) {
        await rm(join(this.directory(sessionId), `${item.id}.png`), { force: true });
        throw e;
      }
      const { used: _, queued: _queued, ...metadata } = item;
      return metadata;
    });
  }
  async read(sessionId: string, id: string) {
    return this.readSaved(
      sessionId,
      (await this.list(sessionId)).find((e) => e.id === id),
    );
  }
  private async readSaved(sessionId: string, item: Saved | undefined) {
    if (!item) throw new Error("not_found: 图片附件不存在或不属于此会话");
    const { used: _, queued: _queued, ...metadata } = item;
    const data = (await readFile(join(this.directory(sessionId), `${item.id}.png`))).toString("base64");
    return { metadata, data };
  }
  async load(sessionId: string, ids: string[]) {
    if (
      !Array.isArray(ids) ||
      ids.length > imageLimits.count ||
      ids.some((id) => typeof id !== "string") ||
      new Set(ids).size !== ids.length
    )
      throw new Error("invalid_input: 图片附件列表无效（最多 8 张）");
    const entries = new Map<string, Saved>();
    for (const item of ids.length ? await this.list(sessionId) : [])
      if (!entries.has(item.id)) entries.set(item.id, item);
    const loaded = await Promise.all(ids.map((id) => this.readSaved(sessionId, entries.get(id))));
    if (loaded.reduce((sum, e) => sum + e.metadata.width * e.metadata.height, 0) > imageLimits.messagePixels)
      throw new Error("invalid_input: 本条消息图片总像素超限");
    return {
      metadata: loaded.map((e) => e.metadata),
      images: loaded.map((e) => ({ type: "image" as const, data: e.data, mimeType: e.metadata.mimeType })),
    };
  }
  async markUsed(sessionId: string, ids: string[]) {
    if (!ids.length) return;
    await this.serial(sessionId, async () => {
      const entries = await this.list(sessionId);
      atomicJson(
        join(this.directory(sessionId), "index.json"),
        entries.map((e) => (ids.includes(e.id) ? { ...e, used: true } : e)),
      );
    });
  }
  async markQueued(sessionId: string, ids: string[], queued: boolean) {
    if (!ids.length) return;
    await this.serial(sessionId, async () => {
      const entries = await this.list(sessionId);
      atomicJson(
        join(this.directory(sessionId), "index.json"),
        entries.map((item) => (ids.includes(item.id) ? { ...item, queued } : item)),
      );
    });
  }
  async remove(sessionId: string, id: string) {
    await this.serial(sessionId, async () => {
      const entries = await this.list(sessionId);
      const item = entries.find((e) => e.id === id);
      if (!item || item.used || item.queued) return;
      atomicJson(
        join(this.directory(sessionId), "index.json"),
        entries.filter((e) => e.id !== id),
      );
      await rm(join(this.directory(sessionId), `${id}.png`), { force: true });
    });
  }
  async deleteSession(id: string) {
    await this.operations.get(id)?.catch(() => {});
    await rm(this.directory(id), { recursive: true, force: true });
  }
}
