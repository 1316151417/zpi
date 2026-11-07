import { createHash, randomUUID } from "node:crypto";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { chmod, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { isJsonObject, type JsonObject } from "zpi-ai";
import {
  hookEvents,
  type PluginSkill,
  type PluginSnapshot,
  parseMarkdownFrontmatter,
  pluginSnapshotData,
  type SessionPlugin,
  validatePluginSnapshot,
} from "zpi-coding-agent";

import { bindCommandHooks, type CommandHook, parseCommandHook } from "./command-hooks.ts";

export {
  bindCommandHooks,
  type CommandHook,
  decodeHookOutput,
  hookInputPayload,
  parseCommandHook,
} from "./command-hooks.ts";

const runtime = "external.command-v1";
const maxFileBytes = 2 * 1024 * 1024;
const maxTreeBytes = 32 * 1024 * 1024;
interface FileEntry {
  path: string;
  bytes: Buffer;
  executable: boolean;
}
interface ExternalData {
  root: string;
  digest: string;
  hooks: CommandHook[];
}

function fail(message: string): never {
  throw new Error(`configuration: 本地插件：${message}`);
}
function tree(root: string): FileEntry[] {
  const files: FileEntry[] = [];
  let bytes = 0,
    entries = 0;
  const walk = (directory: string, depth: number) => {
    if (depth > 16) fail("目录层级超过 16");
    for (const name of readdirSync(directory).sort()) {
      if ([".git", "node_modules"].includes(name)) continue;
      if (++entries > 4000) fail("文件数量超过 4000");
      const path = join(directory, name),
        info = lstatSync(path);
      if (info.isSymbolicLink()) fail(`不接受符号链接：${relative(root, path)}`);
      if (info.isDirectory()) {
        walk(path, depth + 1);
        continue;
      }
      if (!info.isFile() || info.size > maxFileBytes) fail(`文件类型或大小无效：${relative(root, path)}`);
      const content = readFileSync(path);
      bytes += content.length;
      if (content.length > maxFileBytes || bytes > maxTreeBytes) fail("文件内容超过读取上限");
      files.push({
        path: relative(root, path).split(sep).join("/"),
        bytes: content,
        executable: !!(info.mode & 0o111),
      });
    }
  };
  if (!lstatSync(root).isDirectory()) fail("请选择插件根目录");
  walk(root, 0);
  return files;
}
function digest(files: FileEntry[]): string {
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(JSON.stringify([file.path, file.bytes.length, file.executable]));
    hash.update(file.bytes);
  }
  return hash.digest("hex");
}
function json(bytes: Buffer, path: string): JsonObject {
  try {
    const value: unknown = JSON.parse(bytes.toString("utf8"));
    if (isJsonObject(value)) return value;
  } catch {
    /* Report only the component path. */
  }
  return fail(`JSON 无效：${path}`);
}
function markdown(bytes: Buffer, path: string): { fields: JsonObject; body: string } {
  const text = bytes.toString("utf8");
  try {
    return parseMarkdownFrontmatter(text) ?? { fields: {}, body: text.trim() };
  } catch {
    return fail(`frontmatter 无效：${path}`);
  }
}
function relativePath(path: string): string {
  const normalized = path.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/+$/, "");
  if (
    !normalized ||
    isAbsolute(path) ||
    normalized.split("/").some((part) => ["", ".", ".."].includes(part)) ||
    /^[A-Za-z]:/.test(path)
  )
    fail(`组件路径必须位于插件内：${path}`);
  return normalized;
}
function componentFiles(files: FileEntry[], declared: unknown, standard: string): FileEntry[] {
  const paths = declared === undefined ? [standard] : typeof declared === "string" ? [declared] : declared;
  if (!Array.isArray(paths) || paths.some((path) => typeof path !== "string"))
    fail(`组件路径声明无效：${standard}`);
  const roots = [
    ...new Set(
      paths.map((path) =>
        standard === "skills" && [".", "./"].includes(path as string) ? "" : relativePath(path as string),
      ),
    ),
  ];
  const under = (file: FileEntry, root: string) =>
    root === "" || file.path === root || file.path.startsWith(`${root}/`);
  if (declared !== undefined)
    for (const root of roots) if (!files.some((file) => under(file, root))) fail(`组件路径不存在：${root}`);
  if (standard === "skills" && !roots.includes(standard)) roots.push(standard);
  return files.filter((file) => roots.some((root) => under(file, root)));
}

function parseHooks(files: FileEntry[], manifest: JsonObject): CommandHook[] {
  const hooks: CommandHook[] = [],
    loaded = new Set<string>();
  const read = (source: unknown) => {
    if (typeof source === "string") {
      const path = relativePath(source);
      if (loaded.has(path)) return;
      loaded.add(path);
      const file = files.find((file) => file.path === path);
      if (!file) fail(`缺少 hooks 文件：${path}`);
      read(json(file.bytes, path));
      return;
    }
    if (Array.isArray(source)) {
      for (const entry of source) read(entry);
      return;
    }
    if (!isJsonObject(source)) fail("hooks 必须是对象或相对 JSON 路径");
    const events = isJsonObject(source.hooks) ? source.hooks : source;
    for (const [event, groups] of Object.entries(events)) {
      if (!(hookEvents as readonly string[]).includes(event)) fail(`暂不支持 hook 事件：${event}`);
      if (!Array.isArray(groups)) fail(`hook 分组无效：${event}`);
      for (const group of groups) {
        if (
          !isJsonObject(group) ||
          !Array.isArray(group.hooks) ||
          Object.keys(group).some((key) => !["matcher", "hooks"].includes(key))
        )
          fail(`hook 分组字段无效：${event}`);
        for (const hook of group.hooks) {
          hooks.push(parseCommandHook(hook, event, group.matcher));
          if (hooks.length > 100) fail("hooks 数量超过 100");
        }
      }
    }
  };
  if (files.some((file) => file.path === "hooks/hooks.json")) read("hooks/hooks.json");
  if (manifest.hooks !== undefined) read(manifest.hooks);
  return hooks;
}
function rootVariables(text: string, root: string): string {
  return text.replace(/\$\{(?:ZPI|ZCODE|CLAUDE)_PLUGIN_ROOT\}/g, () => root);
}

function compilePlugin(files: FileEntry[], storage: string, treeDigest?: string): PluginSnapshot {
  const manifestFile = [
    ".zpi-plugin/plugin.json",
    ".zcode-plugin/plugin.json",
    ".claude-plugin/plugin.json",
    ".codex-plugin/plugin.json",
  ]
    .map((path) => files.find((file) => file.path === path))
    .find(Boolean);
  if (!manifestFile) fail("找不到插件 manifest");
  const manifest = json(manifestFile.bytes, manifestFile.path);
  if (
    typeof manifest.name !== "string" ||
    !/^[a-z][a-z0-9-]{1,49}$/.test(manifest.name) ||
    (manifest.version !== undefined && (typeof manifest.version !== "string" || !manifest.version.trim()))
  )
    fail("插件 name/version 无效");
  for (const key of [
    "mcpServers",
    "lspServers",
    "ui",
    "outputStyles",
    "settings",
    "entry",
    "main",
    "tools",
    "dependencies",
    "userConfig",
    "channels",
    "experimental",
    "types",
  ])
    if (
      manifest[key] !== undefined ||
      (key === "mcpServers" && files.some((file) => file.path === ".mcp.json")) ||
      (key === "lspServers" && files.some((file) => file.path === ".lsp.json"))
    )
      fail(`暂不支持组件：${key}`);
  const hash = treeDigest ?? digest(files),
    root = join(resolve(storage), "cache", hash);
  const hooks = parseHooks(files, manifest);
  const commands = componentFiles(files, manifest.commands, "commands")
    .filter((file) => /\.md$/i.test(file.path))
    .map((file) => {
      const parsed = markdown(file.bytes, file.path);
      for (const key of ["allowed-tools", "model", "hooks", "skills"])
        if (parsed.fields[key] !== undefined) fail(`暂不支持命令字段 ${key}：${file.path}`);
      if (/!`|```!/.test(parsed.body)) fail(`暂不支持命令 Shell 插值：${file.path}`);
      return {
        name: `${manifest.name}:${basename(file.path, ".md")}`,
        description: String(parsed.fields.description ?? basename(file.path)),
        prompt: rootVariables(parsed.body, root).replace(/\$ARGUMENTS/g, "{{arguments}}"),
      };
    });
  const skills: PluginSkill[] = componentFiles(files, manifest.skills, "skills")
    .filter((file) => basename(file.path) === "SKILL.md")
    .map((file) => {
      const parsed = markdown(file.bytes, file.path);
      if (typeof parsed.fields.description !== "string" || !parsed.fields.description.trim())
        fail(`缺少技能 description：${file.path}`);
      for (const key of ["hooks", "allowed-tools", "context", "agent"])
        if (parsed.fields[key] !== undefined) fail(`暂不支持技能字段 ${key}：${file.path}`);
      return {
        name: `${manifest.name}:${basename(dirname(file.path))}`,
        description: parsed.fields.description,
        path: join(root, file.path),
        baseDir: join(root, dirname(file.path)),
        body: rootVariables(parsed.body, root),
      };
    });
  const agents = componentFiles(files, manifest.agents, "agents")
    .filter((file) => /\.md$/i.test(file.path))
    .map((file) => {
      const parsed = markdown(file.bytes, file.path);
      for (const key of [
        "hooks",
        "skills",
        "permissionMode",
        "mcpServers",
        "memory",
        "maxTurns",
        "background",
        "isolation",
      ])
        if (parsed.fields[key] !== undefined) fail(`暂不支持 Agent 字段 ${key}：${file.path}`);
      return { name: basename(file.path, ".md"), markdown: rootVariables(file.bytes.toString("utf8"), root) };
    });
  const instructions = manifest.instructions ?? [];
  if (!Array.isArray(instructions) || instructions.some((part) => typeof part !== "string"))
    fail("instructions 必须是字符串数组");
  const snapshot: PluginSnapshot = {
    id: `local.${manifest.name}`,
    version: String(manifest.version ?? "unversioned"),
    name: manifest.name,
    description: typeof manifest.description === "string" ? manifest.description : "本地插件",
    runtime,
    instructions: instructions as string[],
    commands,
    skills,
    options: { root, digest: hash, hooks: JSON.parse(JSON.stringify(hooks)), agents },
  };
  validatePluginSnapshot(snapshot);
  if (
    new Set(commands.map((command) => command.name)).size !== commands.length ||
    new Set(skills.map((skill) => skill.name)).size !== skills.length
  )
    fail("组件名称重复");
  return snapshot;
}

/** Import reads data only. No module import, installation scripts or hooks run here. */
export async function importLocalPlugin(source: string, storage: string): Promise<PluginSnapshot> {
  const files = tree(resolve(source));
  const snapshot = compilePlugin(files, storage);
  const root = String(snapshot.options?.root);
  const temporary = join(resolve(storage), `import-${randomUUID()}`);
  await mkdir(temporary, { recursive: true, mode: 0o700 });
  const directories = new Set([temporary]);
  try {
    for (const file of files) {
      const target = join(temporary, file.path);
      const directory = dirname(target);
      if (!directories.has(directory)) {
        await mkdir(directory, { recursive: true, mode: 0o700 });
        directories.add(directory);
      }
      await writeFile(target, file.bytes, { mode: file.executable ? 0o700 : 0o600 });
      await chmod(target, file.executable ? 0o700 : 0o600);
    }
    await mkdir(dirname(root), { recursive: true, mode: 0o700 });
    try {
      await rename(temporary, root);
    } catch (error) {
      if (!["EEXIST", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
    }
    assertExternalPlugin(snapshot, storage, true);
    return snapshot;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
export function isExternalPlugin(snapshot: PluginSnapshot): boolean {
  return snapshot.runtime === runtime;
}
export function assertExternalPlugin(snapshot: PluginSnapshot, storage: string, verifyFiles = false): void {
  validatePluginSnapshot(snapshot);
  const options = snapshot.options;
  if (
    !isExternalPlugin(snapshot) ||
    !snapshot.id.startsWith("local.") ||
    !options ||
    typeof options.digest !== "string" ||
    !/^[a-f0-9]{64}$/.test(options.digest) ||
    options.root !== join(resolve(storage), "cache", options.digest) ||
    !Array.isArray(options.hooks) ||
    !Array.isArray(options.agents)
  )
    fail("快照或运行时无效");
  for (const hook of options.hooks) {
    if (
      !isJsonObject(hook) ||
      !(hookEvents as readonly unknown[]).includes(hook.event) ||
      !["command", "process"].includes(hook.type as string) ||
      typeof hook.command !== "string" ||
      !Array.isArray(hook.args) ||
      hook.args.some((arg) => typeof arg !== "string") ||
      typeof hook.timeoutMs !== "number" ||
      hook.timeoutMs < 1 ||
      hook.timeoutMs > 300000
    )
      fail("hook 快照无效");
    parseCommandHook(
      { type: hook.type, command: hook.command, args: hook.args, timeoutMs: hook.timeoutMs },
      String(hook.event),
      hook.matcher,
    );
  }
  if (verifyFiles) {
    const files = tree(options.root as string);
    const treeDigest = digest(files);
    if (treeDigest !== options.digest) fail("缓存内容已改变，请重新导入插件");
    const expected = compilePlugin(files, storage, treeDigest);
    if (!isDeepStrictEqual(pluginSnapshotData(snapshot), pluginSnapshotData(expected)))
      fail("冻结快照与插件内容不一致");
  }
}

export function bindExternalPlugin(
  snapshot: PluginSnapshot,
  options: { storage: string; transcriptPath?: string; env?: Record<string, string | undefined> },
): SessionPlugin {
  assertExternalPlugin(snapshot, options.storage);
  const data = {
    ...(snapshot.options as unknown as ExternalData),
    id: snapshot.id,
    name: snapshot.name ?? snapshot.id,
  };
  return {
    ...snapshot,
    hooks: bindCommandHooks(data.hooks, {
      root: data.root,
      dataDirectory: join(options.storage, "data", data.id),
      id: data.id,
      name: data.name,
      transcriptPath: options.transcriptPath,
      env: options.env,
      validate: () => assertExternalPlugin(snapshot, options.storage, true),
    }),
  };
}
