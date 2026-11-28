import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import { lstat, mkdir, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { contentText, isJsonObject, type Message } from "@zpi-dev/ai";
import { parseSessionTranscript, type SessionEntry } from "@zpi-dev/coding-agent";
import { previewText } from "../preview.ts";

interface HistoryItem {
  id: string;
  title: string;
  mtime: number;
  error?: string;
}

function byActivity(a: Pick<HistoryItem, "mtime" | "id">, b: Pick<HistoryItem, "mtime" | "id">) {
  return b.mtime - a.mtime || a.id.localeCompare(b.id);
}

export const originalInputEntry = "zpi.cli.input";

// Preserve what the user typed when the provider receives expanded Skill or file context.
export function* displayMessages(entries: Iterable<SessionEntry>): Generator<Message> {
  let original: { inputId: string; text: string } | undefined;
  for (const entry of entries) {
    if (entry.type === "custom" && entry.customType === originalInputEntry && isJsonObject(entry.data)) {
      const { inputId, text } = entry.data;
      if (typeof inputId === "string" && typeof text === "string") original = { inputId, text };
    } else if (entry.type === "message") {
      const message = entry.message;
      if (message.role === "user" && original && message.inputId === original.inputId) {
        yield { ...message, content: original.text };
        original = undefined;
      } else yield message;
    }
  }
}

function firstInput(entries: SessionEntry[]): string | undefined {
  for (const message of displayMessages(entries)) {
    if (message.role !== "user" || message.synthetic) continue;
    const text = message.userGuide?.text ?? contentText(message.content, " ");
    return previewText(text.replace(/\s+/g, " ").trim()) || "图片";
  }
}

export class DirectoryHistory {
  readonly directory: string;
  private readonly cwd: string;

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
    const input = firstInput(snapshot.entries);
    const title =
      input && (snapshot.entries.findLast((entry) => entry.type === "session_info")?.name || input);
    return { entries: snapshot.entries, mtime: info.mtimeMs, title };
  }

  async readForResume(id: string) {
    const { entries, title } = await this.preview(id);
    if (title === undefined) throw new Error("此 CLI 会话没有用户输入");
    return entries;
  }

  async list({ latestOnly = false } = {}): Promise<HistoryItem[]> {
    const directory = join(this.directory, "sessions");
    let files: Dirent[];
    try {
      files = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    let ids = files
      .filter((file) => file.isFile() && file.name.endsWith(".jsonl"))
      .map((file) => file.name.slice(0, -6));
    if (latestOnly) {
      const candidates = await Promise.all(
        ids.map(async (id) => {
          // A failed stat is handled by preview with the same diagnostics as the full list.
          const mtime = await lstat(join(directory, `${id}.jsonl`)).then(
            (info) => info.mtimeMs,
            () => 0,
          );
          return { id, mtime };
        }),
      );
      ids = candidates.sort(byActivity).map((candidate) => candidate.id);
    }
    const items: HistoryItem[] = [];
    for (const id of ids) {
      try {
        const { title, mtime } = await this.preview(id);
        if (title !== undefined) {
          const item = { id, title, mtime };
          if (latestOnly) return [item];
          items.push(item);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT")
          items.push({ id, title: id, mtime: 0, error: String(error) });
      }
    }
    return items.sort(byActivity);
  }
}
