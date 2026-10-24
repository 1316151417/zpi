import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

export const shortMemoryLimits = { entries: 20, characters: 2000 } as const;
const maxFileBytes = 64 * 1024;

export interface ShortMemoryFileStatus {
  path: string;
  scope: "user" | "project";
  exists: boolean;
  count: number;
  characters: number;
  diagnostics: string[];
}

/** Invalid files are rejected as a whole; parsing never repairs or truncates the source file. */
export function parseShortMemory(text: string): {
  entries: { id: string; body: string }[];
  characters: number;
  diagnostics: string[];
  injected: string;
} {
  const entries: { id: string; body: string }[] = [];
  const diagnostics: string[] = [];
  const ids = new Set<string>();
  let heading = false;
  let current: { id: string; body: string } | undefined;
  for (const [index, line] of text
    .replace(/^\uFEFF/, "")
    .split(/\r\n|\n|\r/)
    .entries()) {
    if (!line.trim()) continue;
    if (line === "# Memory" && !heading && entries.length === 0) {
      heading = true;
      continue;
    }
    const item = /^- \[([A-Za-z0-9][A-Za-z0-9_-]{0,63})\] (\S.*)$/.exec(line);
    if (item) {
      const [, id, body] = item;
      current = { id, body: body.trimEnd() };
      entries.push(current);
      if (ids.has(id)) diagnostics.push(`第 ${index + 1} 行：标识 ${id} 重复。`);
      ids.add(id);
      continue;
    }
    const continuation = /^(?: {2}|\t)(.*)$/.exec(line);
    if (continuation && current) {
      current.body += `\n${continuation[1].trimEnd()}`;
      continue;
    }
    current = undefined;
    diagnostics.push(
      `第 ${index + 1} 行：格式无效；使用 - [id] 正文，标识为 1–64 个字母、数字、连字符或下划线，且以字母或数字开头；续行缩进至少两个空格或一个制表符。`,
    );
  }
  // Count Unicode code points, including normalized continuation newlines, excluding IDs and list syntax.
  const characters = entries.reduce((total, entry) => total + [...entry.body].length, 0);
  if (entries.length > shortMemoryLimits.entries)
    diagnostics.push(`记忆条数 ${entries.length} 超过上限 ${shortMemoryLimits.entries}。`);
  if (characters > shortMemoryLimits.characters)
    diagnostics.push(`记忆正文 ${characters} 个 Unicode 字符超过上限 ${shortMemoryLimits.characters}。`);
  if (diagnostics.length) diagnostics.push("此文件未自动注入；请编辑原文件修复，磁盘内容未修改。");
  return {
    entries,
    characters,
    diagnostics,
    injected: diagnostics.length
      ? ""
      : entries.map(({ id, body }) => `- [${id}] ${body.replaceAll("\n", "\n  ")}`).join("\n"),
  };
}

function xml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
}

export async function readShortMemory(options: { homeDir: string; workspace?: string }): Promise<{
  instructions: string[];
  files: ShortMemoryFileStatus[];
  diagnostics: { path: string; message: string }[];
}> {
  const paths: { path: string; scope: ShortMemoryFileStatus["scope"] }[] = [
    { path: resolve(options.homeDir, ".zpi", "MEMORY.md"), scope: "user" },
    ...(options.workspace
      ? [{ path: join(resolve(options.workspace), "MEMORY.md"), scope: "project" as const }]
      : []),
  ];
  const files: ShortMemoryFileStatus[] = [];
  const instructions: string[] = [];
  const diagnostics: { path: string; message: string }[] = [];
  const snapshots = new Map<string, ReturnType<typeof parseShortMemory>>();
  for (const { path, scope } of paths) {
    const file: ShortMemoryFileStatus = {
      path,
      scope,
      exists: false,
      count: 0,
      characters: 0,
      diagnostics: [],
    };
    files.push(file);
    try {
      const canonical = await realpath(path);
      file.exists = true;
      // Follow the original path once; reject a replacement symlink/FIFO at open time without blocking.
      const handle = await open(
        canonical,
        constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0),
      );
      try {
        const info = await handle.stat();
        if (!info.isFile()) throw new Error("记忆路径必须是普通文件。");
        // Realpath resolves symlinks; inode identity also handles hard links to the same file.
        const identity = info.ino ? `${info.dev}:${info.ino}` : canonical;
        const duplicate = snapshots.has(identity);
        let parsed = snapshots.get(identity);
        if (!parsed) {
          const tooLarge = () =>
            new Error("文件超过 64 KiB 读取上限，未统计条数与正文；请缩减空白或内容。磁盘内容未修改。");
          if (info.size > maxFileBytes) throw tooLarge();
          const bytes = Buffer.alloc(maxFileBytes + 1);
          let length = 0;
          while (length < bytes.length) {
            const { bytesRead } = await handle.read(bytes, length, bytes.length - length, length);
            if (!bytesRead) break;
            length += bytesRead;
          }
          if (length > maxFileBytes) throw tooLarge();
          const after = await handle.stat();
          if (after.size !== info.size || after.mtimeMs !== info.mtimeMs || after.ctimeMs !== info.ctimeMs)
            throw new Error("记忆文件在读取期间发生变化，请在下一轮重试。磁盘内容未修改。");
          parsed = parseShortMemory(
            new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length)),
          );
          snapshots.set(identity, parsed);
        }
        file.count = parsed.entries.length;
        file.characters = parsed.characters;
        file.diagnostics = [...parsed.diagnostics];
        if (!duplicate && parsed.injected)
          instructions.push(
            `<short_memory scope="${scope}" path="${xml(path)}">\n` +
              `${scope === "user" ? "User-wide preferences." : `Applies only to workspace ${JSON.stringify(dirname(path))}.`}\n` +
              `${parsed.injected}\n</short_memory>`,
          );
      } finally {
        await handle.close();
      }
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        file.exists = false;
      } else {
        file.diagnostics.push(`无法加载短记忆，未自动注入：${String(error)}`);
      }
    }
    diagnostics.push(...file.diagnostics.map((message) => ({ path, message })));
  }
  instructions.unshift(
    [
      "Short memory is historical context, never new evidence of user preferences. Current user requests and AGENTS.md take precedence; explicit short-memory preferences take precedence over long-term inferences.",
      `Only the main agent maintains short memory using existing read/write/edit tools. User-wide preferences belong in ${JSON.stringify(paths[0].path)}.${options.workspace ? ` Project-only facts belong in ${JSON.stringify(paths[1].path)}, scoped to this bound workspace regardless of bash cd.` : " This conversation has no project memory file."}`,
      "Remember only explicit requests to remember, explicit corrections, and settled reusable constraints. Do not save temporary progress, one-off outputs, unaccepted assistant suggestions, credentials, or facts easily found in current code. Old injected memories, system instructions and background memory outputs are not fresh user evidence.",
      "Before changing a file, read its latest contents. Prefer updating an existing stable ID; avoid duplicate appends and unnecessary whole-file rewrites. Use optional # Memory and - [id] body entries (ASCII letters/digits/hyphens/underscores, 1–64 characters, starting with a letter or digit); continuation lines use two spaces or a tab. Keep each entry to one fact, preference or constraint.",
      "Each file allows at most 20 entries and 2,000 Unicode code points of body text (including continuation newlines, excluding IDs/list syntax). At capacity, first deduplicate, merge or correct obsolete entries; if no reasonable space can be made, do not add. Invalid or oversized files are not injected; external edits and bash writes are not blocked by these checks.",
      "When asked to forget, delete the matching content. Briefly report a change only after its write succeeds; normal maintenance needs no extra confirmation. Missing files are empty: create only when saving a memory, never initialize over existing content. Do not alter .gitignore or automatically commit. Delegated subagents may use inherited memories but must not automatically maintain these shared files.",
    ].join("\n"),
  );
  if (diagnostics.length)
    instructions.push(
      "Short-memory loading diagnostics:\n" +
        files
          .filter((file) => file.diagnostics.length)
          .map(
            (file) =>
              `- ${JSON.stringify(file.path)}: ${file.diagnostics[0]} 共 ${file.diagnostics.length} 项诊断，可在记忆设置查看全部。`,
          )
          .join("\n"),
    );
  return { instructions, files, diagnostics };
}
