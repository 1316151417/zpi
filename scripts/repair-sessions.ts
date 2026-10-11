// Temporary migration for transcripts written before the 0.2.3 naming change.
import { randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import { cp, lstat, mkdir, readdir, readFile, readlink, rename, rm, writeFile } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isJsonObject } from "zpi-ai";
import { isSessionEntry, isSessionHeader, maxSessionEntryBytes, validateTemplate } from "zpi-coding-agent";
import { defaultCapabilities } from "../packages/desktop/src/shared/config.ts";

function normalizeSections(message: unknown): void {
  if (!isJsonObject(message) || message.role !== "system" || !isJsonObject(message.sections)) return;
  const sections = Object.entries(message.sections).map(([key, value]) => [
    key.replace(/^zpi\./i, "zpi."),
    value,
  ]);
  if (new Set(sections.map(([key]) => key)).size !== sections.length)
    throw new Error("Duplicate system section names after migration");
  message.sections = Object.fromEntries(sections);
}

function migrate(content: string): string | null {
  const lines = content.split("\n");
  if (lines.at(-1) === "") lines.pop();
  if (!lines.length) throw new Error("Missing session header");
  let changed = false;
  let parent: string | null = null;
  const ids = new Set<string>();
  const migrated = lines.map((line, index) => {
    if (Buffer.byteLength(line) > maxSessionEntryBytes) throw new Error("Session entry exceeds 8 MiB");
    const row: unknown = JSON.parse(line);
    if (!isJsonObject(row)) throw new Error("Invalid session record");
    const before = JSON.stringify(row);
    if (row.type === "session" && typeof row.format === "string" && /^zpi$/i.test(row.format))
      row.format = "zpi";
    if (row.type === "custom" && typeof row.customType === "string") {
      row.customType = row.customType.replace(/^zpi\./i, "zpi.");
      if (row.customType === "zpi.configuration") {
        if (!isJsonObject(row.data)) throw new Error("Invalid session configuration");
        const config = row.data;
        for (const [key, value] of Object.entries(defaultCapabilities))
          if (!Object.hasOwn(config, key)) config[key] = value;
        validateTemplate(config.template as unknown as Parameters<typeof validateTemplate>[0]);
        if (
          !Array.isArray(config.disabledSkillPaths) ||
          config.disabledSkillPaths.some((path) => typeof path !== "string") ||
          Object.keys(defaultCapabilities).some((key) => typeof config[key] !== "boolean")
        )
          throw new Error("Invalid session configuration");
      }
    }
    normalizeSections(row.message);
    normalizeSections(row.systemMessage);
    if (index === 0) {
      if (!isSessionHeader(row)) throw new Error("Unsupported session header");
    } else {
      if (!isSessionEntry(row) || row.parentId !== parent || ids.has(row.id))
        throw new Error(`Invalid session entry chain or content at line ${index + 1}`);
      ids.add(row.id);
      parent = row.id;
    }
    const after = JSON.stringify(row);
    if (after === before) return line;
    if (Buffer.byteLength(after) > maxSessionEntryBytes) throw new Error("Session entry exceeds 8 MiB");
    changed = true;
    return after;
  });
  return changed ? `${migrated.join("\n")}\n` : null;
}

async function assertClosed(dir: string): Promise<void> {
  const lock = join(dir, "SingletonLock");
  try {
    await lstat(lock);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  const target = await readlink(lock);
  const prefix = `${hostname()}-`;
  const pid = Number(target.slice(prefix.length));
  if (!target.startsWith(prefix) || !Number.isSafeInteger(pid) || pid <= 0)
    throw new Error(`无法确认应用已退出：${lock}`);
  try {
    process.kill(pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
    throw error;
  }
  throw new Error(`请先退出 ZPI / ZPI Preview，再修复：${dir}`);
}

export async function repairSessions(dir: string, dryRun = false) {
  dir = resolve(dir);
  await assertClosed(dir);
  const root = join(dir, "agent", "sessions");
  const plans: { path: string; content: string }[] = [];
  let scanned = 0;
  let partitions: Dirent[];
  try {
    partitions = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { scanned, changed: 0, backup: null };
    throw error;
  }
  for (const partition of partitions) {
    if (!partition.isDirectory() || !/^[a-zA-Z0-9_-]+$/.test(partition.name)) continue;
    for (const file of await readdir(join(root, partition.name), { withFileTypes: true })) {
      if (!file.isFile() || !/^[a-zA-Z0-9_-]+\.jsonl$/.test(file.name)) continue;
      const path = join(root, partition.name, file.name);
      try {
        const content = migrate(await readFile(path, "utf8"));
        if (content !== null) plans.push({ path, content });
      } catch (error) {
        throw new Error(`无法迁移 ${path}；尚未修改任何会话`, { cause: error });
      }
      scanned++;
    }
  }
  if (!plans.length || dryRun) return { scanned, changed: plans.length, backup: null };
  await assertClosed(dir);
  const backup = `${dir}-session-backup-${Date.now()}-${randomUUID().slice(0, 8)}`;
  await mkdir(backup, { mode: 0o700 });
  await cp(root, join(backup, "agent", "sessions"), { recursive: true });
  console.log(`原始会话与索引已备份：${backup}`);
  for (const plan of plans) {
    const temp = `${plan.path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temp, plan.content, { mode: 0o600, flag: "wx" });
      await rename(temp, plan.path);
    } finally {
      await rm(temp, { force: true });
    }
    await rm(`${plan.path}.index.json`, { force: true });
  }
  return { scanned, changed: plans.length, backup };
}

function defaultDirectories(): string[] {
  const appData =
    process.platform === "darwin"
      ? join(homedir(), "Library", "Application Support")
      : process.platform === "win32"
        ? (process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"))
        : (process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"));
  return [join(appData, "ZPI Preview"), join(appData, "ZPI")];
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--help")) {
    console.log("用法：npm run repair:sessions -- [--dry-run] [应用数据目录 ...]");
    return;
  }
  if (args.some((arg) => arg.startsWith("--") && arg !== "--dry-run"))
    throw new Error("未知选项；使用 --help 查看用法");
  const directories = args.filter((arg) => arg !== "--dry-run");
  for (const dir of directories.length ? directories : defaultDirectories()) {
    const result = await repairSessions(dir, args.includes("--dry-run"));
    console.log(
      `${dir}：检查 ${result.scanned} 个会话，${args.includes("--dry-run") ? "待修复" : "已修复"} ${result.changed} 个`,
    );
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
