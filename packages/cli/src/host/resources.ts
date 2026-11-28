import { realpath, stat } from "node:fs/promises";
import { extname, join, relative, resolve, sep } from "node:path";
import {
  FileResourceLoader,
  type InputContext,
  imageLimits,
  prepareInlineImage,
  readFileBounded,
  SkillCatalog,
  type SkillMetadata,
  validateImageSource,
} from "@zpi-dev/coding-agent";
import { CommandImportService } from "../../../desktop/src/main/command-import.ts";
import { prepareCustomCommandPrompt } from "../../../desktop/src/main/custom-command-expansion.ts";
import { CustomCommandsStore } from "../../../desktop/src/main/custom-commands.ts";
import { isPathInside } from "../../../desktop/src/main/path-bounds.ts";
import type { CustomCommand } from "../../../desktop/src/shared/custom-commands.ts";

import { builtinNames, isSessionCommand } from "./commands.ts";

interface CatalogEntry {
  command?: CustomCommand;
  skill?: SkillMetadata;
  problem?: string;
}
const key = (name: string) => name.replace(/^\//, "").toLowerCase();

export class CliResources {
  readonly loader: FileResourceLoader;
  private skills: SkillCatalog;
  private stores: CustomCommandsStore[];

  constructor(cwd: string, homeDir: string) {
    const policy = { projectDir: cwd, homeDir };
    this.loader = new FileResourceLoader({ ...policy, isSkillEnabled: () => false });
    this.skills = new SkillCatalog(policy);
    this.stores = [...new Set([homeDir, cwd])].map((dir) => {
      const rootDirectory = join(dir, ".zpi", "commands");
      const imports = new CommandImportService({
        homeDirectory: homeDir,
        targetDirectory: rootDirectory,
        ...(dir === cwd ? { workspaceDirectory: cwd } : {}),
      });
      return new CustomCommandsStore({
        rootDirectory,
        stateFilePath: join(dir, ".zpi", "command-state.json"),
        importedLinkTargets: () => imports.registeredLinkTargets(),
      });
    });
  }

  async listSkills() {
    await this.skills.reload();
    return this.skills.listSkills().skills;
  }

  private async fileCommands() {
    const catalog = new Map<string, CatalogEntry>();
    const lists = await Promise.all(this.stores.map(async (store) => ({ store, list: await store.list() })));
    for (const { store, list } of lists) {
      for (const command of list.commands) catalog.set(key(command.name), { command });
      for (const issue of list.diagnostics) {
        const message = [issue.path, issue.message].filter(Boolean).join(" — ");
        if (
          issue.path === store.stateFilePath ||
          issue.code === "scan_limit" ||
          issue.path === store.rootDirectory
        )
          throw new Error(message);
        if (issue.path?.toLowerCase().endsWith(".md"))
          catalog.set(key(relative(store.rootDirectory, issue.path).replaceAll(sep, "/").slice(0, -3)), {
            problem: message,
          });
      }
    }
    return catalog;
  }

  private async slashCatalog() {
    const [catalog, skills] = await Promise.all([this.fileCommands(), this.listSkills()]);
    for (const skill of skills) {
      const short = key(skill.name);
      const name =
        /^[\p{L}\p{N}_-]+$/u.test(short) && !builtinNames.has(short) && !catalog.has(short)
          ? short
          : `$${encodeURIComponent(skill.name)}`;
      catalog.set(name, { skill });
    }
    return catalog;
  }

  async listCommands(print = false) {
    const list = [];
    for (const [name, { command, skill }] of await this.slashCatalog()) {
      if (skill) {
        list.push({ name, description: `Skill · ${skill.description}` });
        continue;
      }
      if (!command?.enabled || builtinNames.has(name) || (print && command.disableNonInteractive)) continue;
      const plan = prepareCustomCommandPrompt(command, "");
      if (!plan.parts.some((part) => part.kind === "shell"))
        list.push({ name, description: command.description ?? "" });
    }
    return list;
  }

  async prepare(text: string, options: { skill?: string; print?: boolean; literal?: boolean }) {
    const match =
      !options.literal && /^\s*\/(\$\S+|[\p{L}\p{N}_:-]+(?:\/[\w:-]+)*)(?:\s+([\s\S]*))?$/u.exec(text);
    let body = text;
    let verify: (() => Promise<void>) | undefined;
    let compact = false;
    let required: string[] = [];
    let catalogLoaded = false;
    if (match) {
      const commandName = match[1].startsWith("$") ? match[1] : key(match[1]).replaceAll(":", "/");
      if (builtinNames.has(commandName)) {
        if (!isSessionCommand(commandName)) throw new Error(`/${commandName} 需要在交互终端中使用`);
        compact = commandName === "compact";
        if (compact && options.skill) throw new Error("/compact 不接收 Skill");
        body = `/${commandName}${match[2] ? ` ${match[2]}` : ""}`;
      } else {
        const entry = (await this.slashCatalog()).get(commandName);
        catalogLoaded = true;
        if (entry?.problem) throw new Error(entry.problem);
        if (entry?.skill) {
          required = [entry.skill.name];
          body = [`Use skill ${entry.skill.name}.`, match[2]].filter(Boolean).join("\n\n");
        } else if (entry?.command) {
          const initial = entry.command;
          if (!initial.enabled) throw new Error(`命令已禁用：${initial.filePath}`);
          if (options.print && initial.disableNonInteractive)
            throw new Error(`此命令仅支持交互模式：${initial.filePath}`);
          const plan = prepareCustomCommandPrompt(initial, match[2] ?? "", initial.filePath);
          const fragments = plan.parts.map((part) => {
            if (part.kind === "shell") throw new Error(`此命令需要桌面端：${initial.filePath}`);
            return part.text;
          });
          body = [
            `Run custom command /${plan.name}.`,
            `Command source: ${plan.source}.`,
            "",
            fragments.join("").trim(),
          ].join("\n");
          required = initial.skills ?? [];
          verify = async () => {
            const current = (await this.fileCommands()).get(commandName)?.command;
            if (
              !current?.enabled ||
              current.revision !== initial.revision ||
              current.filePath !== initial.filePath ||
              current.importedSourcePath !== initial.importedSourcePath
            )
              throw new Error(`命令文件在准备期间已更改，请重试：${initial.filePath}`);
          };
        } else if (match[1].includes("/")) return { text, compact: false };
        else throw new Error(`未知命令 /${commandName}。用 /help 查看可用命令。`);
      }
    }
    const skills = new Set([...required, ...(options.skill ? [options.skill] : [])]);
    if (skills.size && !catalogLoaded) await this.skills.reload();
    for (const name of skills) {
      const skill = await this.skills.loadSkill(name);
      body += `\n\nRequired skill: ${skill.name}\nSkill source: ${skill.path}\n${skill.body}`;
    }
    return { text: body, verify, compact };
  }
}

export async function fileContext(
  cwd: string,
  paths: string[] = [],
  clipboardImages: Uint8Array[] = [],
): Promise<InputContext> {
  const context: Required<Pick<InputContext, "fileReferences" | "images">> = {
    fileReferences: [],
    images: [],
  };
  let pixels = 0;
  async function addImage(data: Uint8Array) {
    if (context.images.length >= imageLimits.count) throw new Error("本条消息图片数量超限");
    const metadata = await validateImageSource(data);
    pixels += metadata.width * metadata.height;
    if (pixels > imageLimits.messagePixels) throw new Error("本条消息图片总像素超限");
    const image = await prepareInlineImage(data, metadata.mimeType);
    if (!image.ok) throw new Error(image.message);
    context.images.push({ type: "image", mimeType: image.mimeType, data: image.data });
  }
  for (const bytes of clipboardImages) await addImage(bytes);
  for (const supplied of new Set(paths)) {
    const path = await realpath(resolve(cwd, supplied));
    if (!isPathInside(cwd, path)) throw new Error("引用必须位于当前目录中");
    const name = relative(cwd, path);
    const info = await stat(path);
    if (info.isDirectory()) context.fileReferences.push(`${name || "."}/`);
    else if (!info.isFile()) throw new Error(`无法引用特殊文件：${name}`);
    else if (/^\.(png|jpe?g|webp|gif|bmp)$/i.test(extname(path))) {
      await addImage(await readFileBounded(path, imageLimits.sourceBytes));
    } else context.fileReferences.push(name);
  }
  return context;
}
