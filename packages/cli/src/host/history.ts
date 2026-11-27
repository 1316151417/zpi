import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import { lstat, mkdir, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseSessionTranscript, type SessionEntry } from "@zpi-dev/coding-agent";

export interface HistoryItem {
  id: string;
  title: string;
  mtime: number;
  error?: string;
}

export function firstInput(entries: SessionEntry[]): string | undefined {
  for (const entry of entries) {
    if (entry.type !== "message" || entry.message.role !== "user" || entry.message.synthetic) continue;
    const content = entry.message.content;
    const text =
      typeof content === "string"
        ? content
        : content.flatMap((c) => (c.type === "text" ? [c.text] : [])).join(" ");
    return text.replace(/\s+/g, " ").trim().slice(0, 100) || "图片";
  }
}

export class DirectoryHistory {
  readonly directory: string;
  readonly cwd: string;

  constructor(root: string, cwd: string) {
    this.cwd = cwd;
    this.directory = join(root, createHash("sha256").update(cwd).digest("hex"));
  }

  path(id: string): string {
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id)) throw new Error("无效的会话 ID");
    return join(this.directory, "sessions", `${id}.jsonl`);
  }

  async acquire(id: string) {
    this.path(id);
    const dir = join(this.directory, "locks");
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(join(dir, `${id}.sqlite`));
    try {
      db.exec("BEGIN IMMEDIATE");
    } catch (error) {
      db.close();
      if (error instanceof Error && "errcode" in error && (error.errcode === 5 || error.errcode === 6))
        throw new Error("该 CLI 会话正在被另一个进程使用");
      throw error;
    }
    return () => db.close();
  }

  async preview(id: string) {
    const path = this.path(id);
    const info = await lstat(path);
    if (!info.isFile()) throw new Error("会话必须是普通文件");
    const snapshot = parseSessionTranscript(await readFile(path, "utf8"), { repairIncompleteTail: true });
    if (snapshot.header.id !== id || snapshot.header.cwd !== this.cwd)
      throw new Error("会话与当前目录或 ID 不匹配");
    return { ...snapshot, mtime: info.mtimeMs, title: firstInput(snapshot.entries) };
  }

  async list(): Promise<HistoryItem[]> {
    let files: Dirent[];
    try {
      files = await readdir(join(this.directory, "sessions"), { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const items: HistoryItem[] = [];
    for (const file of files) {
      if (!file.isFile() || !file.name.endsWith(".jsonl")) continue;
      const id = file.name.slice(0, -6);
      try {
        const { title, mtime } = await this.preview(id);
        if (title !== undefined) items.push({ id, title, mtime });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT")
          items.push({ id, title: id, mtime: 0, error: String(error) });
      }
    }
    return items.sort((a, b) => b.mtime - a.mtime || a.id.localeCompare(b.id));
  }
}
