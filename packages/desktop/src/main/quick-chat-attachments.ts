import { randomUUID } from "node:crypto";
import type { ImageContent } from "zpi-ai";
import { type ImageAttachment, imageLimits, prepareInlineImage, validateImageSource } from "zpi-coding-agent";

// Bound cached sources, prepared UTF-16 strings, pending imports and accepted image history together.
export const QUICK_CHAT_IMAGE_MEMORY_BYTES = 128 * 1024 * 1024;
interface Entry {
  metadata: ImageAttachment;
  source: Buffer;
  image: ImageContent;
  note: string;
  used: boolean;
}
export interface QuickChatImages {
  metadata: ImageAttachment[];
  images: ImageContent[];
  context: string;
}

/** Volatile images only. No paths, clipboard access, task directories or persistence. */
export class QuickChatAttachments {
  private entries = new Map<string, Entry>();
  private generation = 0;
  private pending = 0;
  private pendingBytes = 0;
  // Reserve a model-input payload per accepted send, including retries of the same cached ID.
  private historyBytes = 0;
  private imports: Promise<unknown> = Promise.resolve();

  private bytes(): number {
    let total = this.pendingBytes + this.historyBytes;
    for (const entry of this.entries.values()) total += entry.source.length + entry.image.data.length * 2;
    return total;
  }
  private checkBudget(extra: number): void {
    if (this.bytes() + extra > QUICK_CHAT_IMAGE_MEMORY_BYTES)
      throw new Error("busy: 临时图片内存已达上限，请移除草稿图片或开始新对话");
  }
  async import(name: string, bytes: Uint8Array): Promise<ImageAttachment> {
    if (
      typeof name !== "string" ||
      !name ||
      name.length > 250 ||
      !(bytes instanceof Uint8Array) ||
      !bytes.length ||
      bytes.length > imageLimits.sourceBytes
    )
      throw new Error("invalid_input: 图片导入参数无效（单张最多 10 MiB）");
    if ([...this.entries.values()].filter((entry) => !entry.used).length + this.pending >= imageLimits.count)
      throw new Error(`invalid_input: 每个草稿最多 ${imageLimits.count} 张图片`);
    this.checkBudget(bytes.length);
    const source = Buffer.from(bytes);
    const generation = this.generation;
    const current = () => {
      if (generation !== this.generation) throw new Error("not_found: 图片所属的临时对话已结束");
    };
    this.pending++;
    this.pendingBytes += source.length;
    // Decode one source at a time, reserving admission before any asynchronous work.
    const imported = this.imports.then(async () => {
      current();
      const info = await validateImageSource(source);
      current();
      const prepared = await prepareInlineImage(source, info.mimeType);
      current();
      if (!prepared.ok) throw new Error(`invalid_input: ${prepared.message}`);
      this.checkBudget(prepared.data.length * 2);
      const metadata: ImageAttachment = { id: randomUUID(), name, size: source.length, ...info };
      this.entries.set(metadata.id, {
        metadata,
        source,
        image: { type: "image", data: prepared.data, mimeType: prepared.mimeType },
        note: prepared.hints.length
          ? `Attached image ${JSON.stringify(name)}: ${prepared.hints.join("\n")}`
          : "",
        used: false,
      });
      return { ...metadata };
    });
    this.imports = imported.catch(() => {});
    try {
      return await imported;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        /^(invalid_input|not_found|busy):/.test(message) ? message : `invalid_input: ${message}`,
      );
    } finally {
      this.pending--;
      this.pendingBytes -= source.length;
    }
  }
  private entry(id: string): Entry {
    const entry = typeof id === "string" ? this.entries.get(id) : undefined;
    if (!entry) throw new Error("not_found: 图片不存在或不属于此临时对话");
    return entry;
  }
  read(id: string): { metadata: ImageAttachment; data: string } {
    const entry = this.entry(id);
    return { metadata: { ...entry.metadata }, data: entry.source.toString("base64") };
  }
  remove(id: string): void {
    const entry = this.entry(id);
    // Accepted messages and retryable failures share their immutable image records.
    if (!entry.used) this.entries.delete(id);
  }
  load(ids: string[]): QuickChatImages {
    if (
      !Array.isArray(ids) ||
      ids.length > imageLimits.count ||
      ids.some((id) => typeof id !== "string") ||
      new Set(ids).size !== ids.length
    )
      throw new Error(`invalid_input: 图片列表无效（最多 ${imageLimits.count} 张）`);
    const entries = ids.map((id) => this.entry(id));
    if (
      entries.reduce((sum, entry) => sum + entry.metadata.width * entry.metadata.height, 0) >
      imageLimits.messagePixels
    )
      throw new Error("invalid_input: 本条消息图片总像素超限");
    this.checkBudget(entries.reduce((sum, entry) => sum + entry.image.data.length * 2, 0));
    return {
      metadata: entries.map((entry) => ({ ...entry.metadata })),
      images: entries.map((entry) => ({ ...entry.image })),
      context: entries
        .map((entry) => entry.note)
        .filter(Boolean)
        .join("\n\n"),
    };
  }
  markUsed(ids: string[]): void {
    for (const id of ids) {
      const entry = this.entry(id);
      entry.used = true;
      this.historyBytes += entry.image.data.length * 2;
    }
  }
  clearDraft(): void {
    this.generation++;
    for (const [id, entry] of this.entries) if (!entry.used) this.entries.delete(id);
    // Pending input copies stay budgeted until their old, serialized work releases them.
  }
  clear(): void {
    this.clearDraft();
    this.entries.clear();
    this.historyBytes = 0;
  }
}
