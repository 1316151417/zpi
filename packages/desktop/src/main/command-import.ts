// Source list and selection/copy/link semantics adapted from ZCode settingsSyncService (Apache-2.0).
import { createHash, randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { link, lstat, mkdir, open, readdir, rename, symlink, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import type {
  CommandImportCandidate,
  CommandImportDiscovery,
  CommandImportItemResult,
  CommandImportRequest,
  CommandImportResult,
  CommandImportSkipReason,
  CommandImportSource,
} from "../shared/command-import.ts";
import { parseCustomCommandMarkdown } from "./custom-commands.ts";

/** Deliberately matches ZCode's command list, not its broader skill source list. */
export const COMMAND_IMPORT_SOURCES = [
  { id: "claudeCode", label: "Claude Code", path: ".claude/commands", projectPath: ".claude/commands" },
  { id: "codexCli", label: "Codex CLI", path: ".codex/commands", projectPath: ".codex/commands" },
  { id: "openCode", label: "OpenCode", path: ".config/opencode/commands", projectPath: ".opencode/commands" },
  { id: "openClaw", label: "OpenClaw", path: ".openclaw/commands", projectPath: "commands" },
  { id: "augment", label: "Augment", path: ".augment/commands", projectPath: ".augment/commands" },
  { id: "continue", label: "Continue", path: ".continue/commands", projectPath: ".continue/commands" },
  { id: "goose", label: "Goose", path: ".config/goose/commands", projectPath: ".goose/commands" },
  { id: "qwenCode", label: "Qwen Code", path: ".qwen/commands", projectPath: ".qwen/commands" },
  { id: "qode", label: "Qoder", path: ".qoder/commands", projectPath: ".qoder/commands" },
  { id: "qodeCn", label: "Qoder CN", path: ".qoder-cn/commands", projectPath: ".qoder/commands" },
  {
    id: "windsurf",
    label: "Windsurf",
    path: ".codeium/windsurf/commands",
    projectPath: ".windsurf/commands",
  },
  { id: "trae", label: "Trae", path: ".trae/commands", projectPath: ".trae/commands" },
  { id: "kiroCli", label: "Kiro CLI", path: ".kiro/commands", projectPath: ".kiro/commands" },
  { id: "roo", label: "Roo", path: ".roo/commands", projectPath: ".roo/commands" },
  { id: "codeBuddy", label: "CodeBuddy", path: ".codebuddy/commands", projectPath: ".codebuddy/commands" },
] as const;

const MAX_FILE_BYTES = 256 * 1024;
const MAX_ENTRIES = 10_000;
const MAX_COMMANDS = 1000;
const MAX_TOTAL_BYTES = 16 * 1024 * 1024;
const MAX_DEPTH = 8;
const REGISTRY_FILE = ".import-links.json";
interface ImportSnapshot extends CommandImportCandidate {
  sourceRoot: string;
}
interface FileSnapshot {
  content: Buffer;
  revision: string;
}
export interface CommandImportOptions {
  homeDirectory: string;
  targetDirectory: string;
  platform?: NodeJS.Platform;
  workspaceDirectory?: string;
}
function code(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException)?.code;
}
function inside(root: string, path: string): boolean {
  const suffix = relative(root, path);
  return !isAbsolute(suffix) && suffix !== ".." && !suffix.startsWith(`..${sep}`);
}
function commandName(path: string): string {
  return `/${path.replaceAll(sep, "/").replace(/\.md$/i, "")}`;
}
function nameKey(path: string): string {
  return commandName(path).toLowerCase();
}
function validRelativePath(path: string): boolean {
  return (
    Boolean(path) &&
    path.length <= 1024 &&
    !isAbsolute(path) &&
    !/[\\:]/.test(path) &&
    ![...path].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127) &&
    /\.md$/i.test(path) &&
    path
      .split("/")
      .every((part) => part && !part.startsWith(".") && !part.endsWith(".") && !part.endsWith(" "))
  );
}
function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** No I/O in construction. Discovery is called only from the explicitly opened import dialog. */
export class CommandImportService {
  private readonly home: string;
  private readonly target: string;
  private readonly workspace?: string;
  private readonly platform: NodeJS.Platform;
  private readonly scans = new Map<string, Map<string, ImportSnapshot>>();
  private mutation: Promise<unknown> = Promise.resolve();

  constructor(options: CommandImportOptions) {
    if (!isAbsolute(options.homeDirectory) || !isAbsolute(options.targetDirectory)) {
      throw new Error("命令导入需要明确的绝对目录路径。");
    }
    this.home = resolve(options.homeDirectory);
    this.target = resolve(options.targetDirectory);
    this.platform = options.platform ?? process.platform;
    if (options.workspaceDirectory && !isAbsolute(options.workspaceDirectory)) {
      throw new Error("项目命令导入需要明确的绝对目录路径。");
    }
    this.workspace = options.workspaceDirectory ? resolve(options.workspaceDirectory) : undefined;
    if (
      this.target !== join(this.home, ".zpi", "commands") &&
      (!this.workspace || this.target !== join(this.workspace, ".zpi", "commands"))
    ) {
      throw new Error("命令只能导入到用户或项目的 .zpi/commands 目录。");
    }
  }

  private sourceRoots(): Array<{ id: string; label: string; path: string; scope: "global" | "project" }> {
    return [
      ...COMMAND_IMPORT_SOURCES.map((source) => ({
        id: `${source.id}:global`,
        label: source.label,
        path: join(this.home, source.path),
        scope: "global" as const,
      })),
      ...(this.workspace
        ? COMMAND_IMPORT_SOURCES.map((source) => ({
            id: `${source.id}:project`,
            label: source.label,
            path: join(this.workspace as string, source.projectPath),
            scope: "project" as const,
          }))
        : []),
    ];
  }

  /** Require an injected scope, then check every ancestor from the filesystem root. */
  private async directories(path: string, create = false): Promise<boolean> {
    const anchor = [this.home, ...(this.workspace ? [this.workspace] : [])]
      .filter((root) => inside(root, path))
      .sort((left, right) => right.length - left.length)[0];
    if (!anchor) throw new Error("目录超出了允许范围。");
    let current = parse(anchor).root;
    const parts = relative(current, path).split(sep).filter(Boolean);
    for (let index = -1; index < parts.length; index++) {
      if (index >= 0) current = join(current, parts[index]);
      let stat: Stats;
      try {
        stat = await lstat(current);
      } catch (error) {
        if (code(error) !== "ENOENT") throw error;
        if (!create) return false;
        try {
          await mkdir(current);
        } catch (mkdirError) {
          if (code(mkdirError) !== "EEXIST") throw mkdirError;
        }
        stat = await lstat(current);
      }
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new Error("为避免访问目录外的文件，已拒绝符号链接目录。");
      }
    }
    return true;
  }

  private async snapshot(path: string, root: string, maxBytes = MAX_FILE_BYTES): Promise<FileSnapshot> {
    if (
      !inside(root, path) ||
      path === root ||
      (!inside(this.home, root) && (!this.workspace || !inside(this.workspace, root)))
    ) {
      throw new Error("命令文件超出了允许范围。");
    }
    if (!(await this.directories(dirname(path)))) throw new Error("源命令已不存在，请重新扫描。");
    const before = await lstat(path);
    if (!before.isFile() || before.isSymbolicLink()) throw new Error("只能导入普通 Markdown 文件。");
    if (before.size > maxBytes) throw new Error("命令文件超过 256 KiB 限制。");
    const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > maxBytes || stat.dev !== before.dev || stat.ino !== before.ino) {
        throw new Error("源命令已发生变化，请重新扫描。");
      }
      const content = Buffer.alloc(stat.size + 1);
      const { bytesRead } = await file.read(content, 0, content.length, 0);
      const after = await file.stat();
      if (
        bytesRead !== stat.size ||
        after.size !== stat.size ||
        after.mtimeMs !== stat.mtimeMs ||
        after.ctimeMs !== stat.ctimeMs
      ) {
        throw new Error("源命令已发生变化，请重新扫描。");
      }
      await this.directories(dirname(path));
      const current = await lstat(path);
      if (current.isSymbolicLink() || current.dev !== stat.dev || current.ino !== stat.ino) {
        throw new Error("源命令已发生变化，请重新扫描。");
      }
      const bytes = content.subarray(0, bytesRead);
      const revision = createHash("sha256")
        .update(`${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}:`)
        .update(bytes)
        .digest("hex");
      return { content: bytes, revision };
    } finally {
      await file.close();
    }
  }

  private async paths(root: string, allowFileLinks = false): Promise<string[]> {
    if (!(await this.directories(root))) return [];
    const found: string[] = [];
    let count = 0;
    const visit = async (directory: string, depth: number): Promise<void> => {
      if (depth > MAX_DEPTH) throw new Error("命令目录嵌套超过 8 层限制。");
      await this.directories(directory);
      const entries = await readdir(directory, { withFileTypes: true });
      for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
        if (++count > MAX_ENTRIES) throw new Error("命令目录超过 10,000 个条目限制。");
        if (entry.name.startsWith(".")) continue;
        const path = join(directory, entry.name);
        if (entry.isDirectory()) await visit(path, depth + 1);
        else if (
          /\.md$/i.test(entry.name) &&
          (entry.isFile() || (allowFileLinks && entry.isSymbolicLink()))
        ) {
          found.push(path);
        }
      }
    };
    await visit(root, 0);
    return found;
  }

  private async conflict(path: string, names: Set<string>): Promise<CommandImportSkipReason | undefined> {
    try {
      await lstat(join(this.target, path));
      return "targetExists";
    } catch (error) {
      if (code(error) !== "ENOENT" && code(error) !== "ENOTDIR") throw error;
    }
    return names.has(nameKey(path)) ? "sameNameExists" : undefined;
  }

  async discover(): Promise<CommandImportDiscovery> {
    const scanId = randomUUID();
    const snapshots = new Map<string, ImportSnapshot>();
    const sources: CommandImportSource[] = [];
    const warnings: string[] = [];
    const names = new Set(
      (await this.paths(this.target, true)).map((path) => nameKey(relative(this.target, path))),
    );
    const seenPaths = new Set<string>();
    let totalBytes = 0;
    let exhausted = false;
    for (const source of this.sourceRoots()) {
      const root = source.path;
      const commands: CommandImportCandidate[] = [];
      try {
        for (const path of await this.paths(root)) {
          if (seenPaths.has(path)) continue;
          seenPaths.add(path);
          try {
            if (snapshots.size >= MAX_COMMANDS) {
              warnings.push("扫描已达到 1,000 个命令限制，后续文件未扫描。");
              exhausted = true;
              break;
            }
            const file = await this.snapshot(path, root);
            totalBytes += file.content.length;
            if (totalBytes > MAX_TOTAL_BYTES) {
              warnings.push("扫描已达到 16 MiB 总内容限制，后续文件未扫描。");
              exhausted = true;
              break;
            }
            const relativePath = relative(root, path).replaceAll(sep, "/");
            if (!validRelativePath(relativePath)) throw new Error("命令文件名不受支持。");
            const parsed = parseCustomCommandMarkdown(file.content.toString("utf8"));
            const skipReason = await this.conflict(relativePath, names);
            const candidate: CommandImportCandidate = {
              id: randomUUID(),
              revision: file.revision,
              name: commandName(relativePath),
              description: parsed.description,
              argumentHint: parsed.argumentHint,
              sourcePath: path,
              relativePath,
              importable: !skipReason,
              ...(skipReason ? { skipReason } : {}),
            };
            commands.push(candidate);
            snapshots.set(candidate.id, { ...candidate, sourceRoot: root });
          } catch (error) {
            warnings.push(`${path}: ${message(error)}`);
          }
        }
      } catch (error) {
        warnings.push(`${source.label}: ${message(error)}`);
      }
      if (commands.length)
        sources.push({ id: source.id, label: source.label, path: root, scope: source.scope, commands });
      if (exhausted) break;
    }
    this.scans.set(scanId, snapshots);
    while (this.scans.size > 8) this.scans.delete(this.scans.keys().next().value as string);
    return {
      scanId,
      targetDirectory: this.target,
      targetScope: this.target === join(this.home, ".zpi", "commands") ? "global" : "project",
      projectAvailable: Boolean(this.workspace),
      sources,
      warnings,
    };
  }

  /** Loads explicit link provenance only; does not discover or read external command contents. */
  async registeredLinkTargets(): Promise<ReadonlyMap<string, string>> {
    if (!(await this.directories(this.target))) return new Map();
    let snapshot: FileSnapshot;
    try {
      snapshot = await this.snapshot(join(this.target, REGISTRY_FILE), this.target, 1024 * 1024);
    } catch (error) {
      if (code(error) === "ENOENT") return new Map();
      throw error;
    }
    const data: unknown = JSON.parse(snapshot.content.toString("utf8"));
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("导入链接记录无效。");
    const registered = new Map<string, string>();
    for (const [target, source] of Object.entries(data)) {
      if (typeof source !== "string" || !isAbsolute(source) || resolve(source) !== source) continue;
      const match = this.sourceRoots().find(({ path: root }) => {
        return inside(root, source) && relative(root, source).replaceAll(sep, "/") === target;
      });
      if (match && validRelativePath(target)) {
        registered.set(target, source);
      }
    }
    return registered;
  }

  private async saveLinks(links: ReadonlyMap<string, string>): Promise<void> {
    await this.directories(this.target, true);
    const path = join(this.target, REGISTRY_FILE);
    const temporary = join(this.target, `${REGISTRY_FILE}.${randomUUID()}.tmp`);
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(`${JSON.stringify(Object.fromEntries(links), null, 2)}\n`, "utf8");
      await file.sync();
    } finally {
      await file.close();
    }
    try {
      await this.directories(this.target);
      await rename(temporary, path);
    } finally {
      await unlink(temporary).catch(() => {});
    }
  }

  importSelected(request: CommandImportRequest): Promise<CommandImportResult> {
    const operation = this.mutation.then(() => this.performImport(request));
    this.mutation = operation.catch(() => {});
    return operation;
  }

  private async performImport(request: CommandImportRequest): Promise<CommandImportResult> {
    if (
      !request ||
      typeof request.scanId !== "string" ||
      (request.mode !== "copy" && request.mode !== "symlink") ||
      !Array.isArray(request.selections) ||
      !request.selections.length ||
      request.selections.length > MAX_COMMANDS
    ) {
      throw new Error("命令导入请求无效。");
    }
    const scan = this.scans.get(request.scanId);
    if (!scan) throw new Error("扫描结果已过期，请重新扫描。");
    const selected = new Set<string>();
    for (const item of request.selections) {
      if (
        !item ||
        typeof item.id !== "string" ||
        typeof item.revision !== "string" ||
        selected.has(item.id)
      ) {
        throw new Error("命令选择无效。");
      }
      const candidate = scan.get(item.id);
      if (!candidate || candidate.revision !== item.revision) throw new Error("命令选择已过期，请重新扫描。");
      selected.add(item.id);
    }
    const items: CommandImportItemResult[] = [];
    const links = new Map(await this.registeredLinkTargets());
    const names = new Set(
      (await this.paths(this.target, true)).map((path) => nameKey(relative(this.target, path))),
    );
    for (const id of selected) {
      const candidate = scan.get(id) as ImportSnapshot;
      const base = { id, name: candidate.name, sourcePath: candidate.sourcePath };
      try {
        const file = await this.snapshot(candidate.sourcePath, candidate.sourceRoot);
        if (file.revision !== candidate.revision) throw new Error("源命令已发生变化，请重新扫描。");
        const skipReason = await this.conflict(candidate.relativePath, names);
        if (skipReason) {
          items.push({ ...base, status: "skipped", skipReason });
          continue;
        }
        const target = join(this.target, candidate.relativePath);
        await this.directories(dirname(target), true);
        const method = request.mode;
        if (method === "symlink") {
          try {
            await symlink(candidate.sourcePath, target, "file");
          } catch (error) {
            if (this.platform === "win32" && (code(error) === "EPERM" || code(error) === "EACCES")) {
              throw new Error("当前 Windows 环境不允许创建软链。请选择“直接复制”后重试。");
            }
            throw error;
          }
          links.set(candidate.relativePath, candidate.sourcePath);
          try {
            const current = await this.snapshot(candidate.sourcePath, candidate.sourceRoot);
            if (current.revision !== candidate.revision) throw new Error("源命令已发生变化，请重新扫描。");
            await this.saveLinks(links);
          } catch (error) {
            links.delete(candidate.relativePath);
            await unlink(target);
            throw error;
          }
        } else {
          const temporary = join(dirname(target), `.command-import-${randomUUID()}.tmp`);
          let published = false;
          try {
            const output = await open(temporary, "wx", 0o600);
            try {
              await output.writeFile(file.content);
              await output.sync();
            } finally {
              await output.close();
            }
            await this.directories(dirname(target));
            // link is an atomic no-clobber publish; removing the staging name leaves nlink === 1.
            await link(temporary, target);
            published = true;
            await unlink(temporary);
          } catch (error) {
            if (published) await unlink(target).catch(() => {});
            throw error;
          } finally {
            await unlink(temporary).catch(() => {});
          }
        }
        names.add(nameKey(candidate.relativePath));
        items.push({ ...base, status: "imported", method });
      } catch (error) {
        if (code(error) === "EEXIST") items.push({ ...base, status: "skipped", skipReason: "targetExists" });
        else items.push({ ...base, status: "failed", error: message(error) });
      }
    }
    return {
      importedCount: items.filter((item) => item.status === "imported").length,
      skippedCount: items.filter((item) => item.status === "skipped").length,
      failedCount: items.filter((item) => item.status === "failed").length,
      items,
    };
  }
}
