import {
  type Attachment,
  createReadTool,
  type FileAttachment,
  type ImageAttachment,
  imageFormat,
  imageLimits,
  isImageAttachment,
  processImage,
} from "ZPI-coding-agent";
import { randomUUID } from "node:crypto";
import { mkdir, open, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { basename, extname, isAbsolute, join } from "node:path";
import { atomicJson } from "./storage.ts";

type Saved = Attachment & {
  used: boolean;
  queued?: boolean;
  cached?: boolean;
};
// 与 ZCode 普通附件一致：已知文本预读，二进制只交付路径，避免把乱码塞进模型上下文。
const textExtensions =
  /\.(cjs|conf|cpp|cs|css|csv|go|h|hpp|html|ini|java|js|json|jsx|log|md|mjs|py|rs|sh|sql|toml|ts|tsx|txt|xml|yaml|yml)$/i;
const mimeTypes: Record<string, string> = {
  pdf: "application/pdf",
  json: "application/json",
  csv: "text/csv",
  md: "text/markdown",
  mp4: "video/mp4",
  m4v: "video/x-m4v",
  webm: "video/webm",
  mov: "video/quicktime",
  mkv: "video/x-matroska",
  avi: "video/x-msvideo",
  svg: "image/svg+xml",
  mp3: "audio/mpeg",
  wav: "audio/wav",
};
export class AttachmentStore {
  private root: string;
  constructor(root: string) {
    this.root = root;
  }
  private directory(sessionId: string) {
    if (!/^[a-zA-Z0-9_-]+$/.test(sessionId)) throw new Error("invalid_input: 无效会话 ID");
    return join(this.root, sessionId);
  }
  private imagePath(sessionId: string, id: string) {
    if (typeof id !== "string" || !/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error("invalid_input: 无效附件 ID");
    return join(this.directory(sessionId), `${id}.png`);
  }
  private filePath(sessionId: string, id: string) {
    return this.imagePath(sessionId, id).replace(/\.png$/, ".file");
  }
  async importFile(sessionId: string, path: string): Promise<Attachment> {
    path = await realpath(path);
    const info = await stat(path);
    if (!info.isFile()) throw new Error("invalid_input: 附件必须是文件");
    const name = basename(path);
    if (/\.(png|jpe?g|gif|webp|bmp)$/i.test(name)) {
      if (info.size > imageLimits.sourceBytes) throw new Error("invalid_input: 图片单张上限为 10 MiB");
      return this.import(sessionId, name, await readFile(path));
    }
    return this.saveFile(sessionId, name, path, info.size);
  }
  async importBytes(sessionId: string, name: string, bytes: Uint8Array): Promise<Attachment> {
    if (!name || name.length > 250 || !(bytes instanceof Uint8Array) || bytes.length > 20 * 1024 * 1024)
      throw new Error("invalid_input: 附件导入参数无效（最多 20 MiB）");
    if (imageFormat(bytes)) return this.import(sessionId, name, bytes);
    return this.saveFile(sessionId, basename(name), undefined, bytes.length, bytes);
  }
  private saveFile(
    sessionId: string,
    name: string,
    path: string | undefined,
    size: number,
    bytes?: Uint8Array,
  ) {
    return this.serial(sessionId, async () => {
      const entries = await this.list(sessionId);
      if (entries.filter((e) => !e.used && !e.queued).length >= imageLimits.count)
        throw new Error("invalid_input: 每个草稿最多 8 个附件");
      const id = randomUUID();
      const item: FileAttachment = {
        id,
        name,
        path: path ?? this.filePath(sessionId, id),
        size,
        mimeType:
          mimeTypes[extname(name).slice(1).toLowerCase()] ??
          (textExtensions.test(name) ? "text/plain" : "application/octet-stream"),
      };
      await mkdir(this.directory(sessionId), { recursive: true });
      if (bytes) await writeFile(item.path, bytes, { mode: 0o600 });
      try {
        atomicJson(join(this.directory(sessionId), "index.json"), [
          ...entries,
          { ...item, used: false, ...(bytes ? { cached: true } : {}) },
        ]);
      } catch (error) {
        if (bytes) await rm(item.path, { force: true });
        throw error;
      }
      return item;
    });
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
  async cleanUnsent(onError: (error: unknown, sessionId: string) => void = () => {}): Promise<void> {
    await mkdir(this.root, { recursive: true });
    for (const dir of await readdir(this.root, { withFileTypes: true })) {
      if (!dir.isDirectory() || !/^[a-zA-Z0-9_-]+$/.test(dir.name)) continue;
      try {
        for (const item of await this.list(dir.name))
          if (!item.used && !item.queued) await this.remove(dir.name, item.id);
        const keep = new Set(
          (await this.list(dir.name)).map((item) => `${item.id}.${isImageAttachment(item) ? "png" : "file"}`),
        );
        for (const file of await readdir(this.directory(dir.name)))
          if (/\.(png|file)$/.test(file) && !keep.has(file))
            await rm(join(this.directory(dir.name), file), { force: true });
      } catch (error) {
        onError(error, dir.name);
      }
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
        throw new Error("invalid_input: 每个草稿最多 8 个附件");
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
      await writeFile(this.imagePath(sessionId, item.id), processed.bytes, { mode: 0o600 });
      try {
        atomicJson(join(this.directory(sessionId), "index.json"), [...entries, item]);
      } catch (e) {
        await rm(this.imagePath(sessionId, item.id), { force: true });
        throw e;
      }
      const { used: _, queued: _queued, cached: _cached, ...metadata } = item;
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
    const image = await this.readSavedBytes(sessionId, item);
    return { metadata: image.metadata, data: image.data.toString("base64") };
  }
  private async readSavedBytes(sessionId: string, item: Saved | undefined) {
    if (!item) throw new Error("not_found: 附件不存在或不属于此会话");
    this.imagePath(sessionId, item.id);
    const { used: _, queued: _queued, cached: _cached, ...metadata } = item;
    if (!isImageAttachment(metadata)) {
      if (!isAbsolute(metadata.path) || (item.cached && metadata.path !== this.filePath(sessionId, item.id)))
        throw new Error("invalid_input: 附件文件路径无效");
      return { metadata, data: Buffer.alloc(0) };
    }
    const data = await readFile(this.imagePath(sessionId, item.id));
    return { metadata, data };
  }
  async load(sessionId: string, ids: string[]) {
    if (
      !Array.isArray(ids) ||
      ids.length > imageLimits.count ||
      ids.some((id) => typeof id !== "string") ||
      new Set(ids).size !== ids.length
    )
      throw new Error("invalid_input: 附件列表无效（最多 8 个）");
    const entries = new Map<string, Saved>();
    for (const item of ids.length ? await this.list(sessionId) : [])
      if (!entries.has(item.id)) entries.set(item.id, item);
    const loaded = await Promise.all(ids.map((id) => this.readSaved(sessionId, entries.get(id))));
    const images = loaded.filter((e): e is typeof e & { metadata: ImageAttachment } =>
      isImageAttachment(e.metadata),
    );
    if (images.reduce((sum, e) => sum + e.metadata.width * e.metadata.height, 0) > imageLimits.messagePixels)
      throw new Error("invalid_input: 本条消息图片总像素超限");
    const files: string[] = [];
    for (const { metadata } of loaded) {
      if (isImageAttachment(metadata)) continue;
      const info = await stat(metadata.path);
      if (!info.isFile()) throw new Error("invalid_input: 附件文件不可用");
      const header = `Attached ${metadata.mimeType}: ${JSON.stringify(metadata.path)} (${metadata.name})`;
      const reference = `${header}\nUse the available file reading tools to inspect this file when needed.`;
      if (textExtensions.test(metadata.name)) {
        // Limit native-file I/O as well as model output. Large attachments remain available by path.
        const file = await open(metadata.path, "r");
        let prefix: string;
        try {
          const buffer = Buffer.alloc(64 * 1024);
          const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
          const bytes = buffer.subarray(0, bytesRead);
          if (bytes.includes(0)) {
            files.push(reference);
            continue;
          }
          try {
            prefix = new TextDecoder("utf-8", { fatal: true }).decode(bytes, {
              stream: info.size > bytesRead,
            });
          } catch {
            files.push(reference);
            continue;
          }
        } finally {
          await file.close();
        }
        const result = await createReadTool(this.directory(sessionId), {
          operations: { access: async () => undefined, readFile: async () => Buffer.from(prefix) },
        }).execute("attachment", { path: metadata.path });
        files.push(
          `${header}\n${result.content
            .filter((part) => part.type === "text")
            .map((part) => part.text)
            .join(
              "\n",
            )}${info.size > 64 * 1024 ? "\n[Partial attachment preview. Use read with this path to continue.]" : ""}`,
        );
      } else files.push(reference);
    }
    return {
      metadata: loaded.map((e) => e.metadata),
      images: images.map((e) => ({ type: "image" as const, data: e.data, mimeType: e.metadata.mimeType })),
      fileContext: files.join("\n\n"),
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
    const path = this.imagePath(sessionId, id);
    await this.serial(sessionId, async () => {
      const entries = await this.list(sessionId);
      const item = entries.find((e) => e.id === id);
      if (!item || item.used || item.queued) return;
      atomicJson(
        join(this.directory(sessionId), "index.json"),
        entries.filter((e) => e.id !== id),
      );
      if (isImageAttachment(item)) await rm(path, { force: true });
      else if (item.cached) await rm(this.filePath(sessionId, id), { force: true });
    });
  }
  async copyTo(sourceId: string, targetId: string, ids: string[]): Promise<void> {
    if (!ids.length) return;
    const entries = new Map((await this.list(sourceId)).map((item) => [item.id, item]));
    await this.serial(targetId, async () => {
      const metadata: Saved[] = [];
      await mkdir(this.directory(targetId), { recursive: true });
      for (const id of new Set(ids)) {
        const image = await this.readSavedBytes(sourceId, entries.get(id));
        if (isImageAttachment(image.metadata)) {
          await writeFile(this.imagePath(targetId, id), image.data, { mode: 0o600 });
          metadata.push({ ...image.metadata, used: true });
        } else if (entries.get(id)?.cached) {
          const path = this.filePath(targetId, id);
          await writeFile(path, await readFile(this.filePath(sourceId, id)), { mode: 0o600 });
          metadata.push({ ...image.metadata, path, used: true, cached: true });
        } else metadata.push({ ...image.metadata, used: true });
      }
      atomicJson(join(this.directory(targetId), "index.json"), metadata);
    });
  }
  async deleteSession(id: string) {
    await this.operations.get(id)?.catch(() => {});
    await rm(this.directory(id), { recursive: true, force: true });
  }
}
