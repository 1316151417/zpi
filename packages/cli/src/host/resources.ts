import { realpath, stat } from "node:fs/promises";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  FileResourceLoader,
  type InputContext,
  imageLimits,
  prepareInlineImage,
  readFileBounded,
  SkillCatalog,
  validateImageSource,
} from "@zpi-dev/coding-agent";
import { CommandImportService } from "../../../desktop/src/main/command-import.ts";
import { prepareCustomCommandPrompt } from "../../../desktop/src/main/custom-command-expansion.ts";
import { CustomCommandsStore } from "../../../desktop/src/main/custom-commands.ts";
import type { CustomCommand } from "../../../desktop/src/shared/custom-commands.ts";

import { builtinNames } from "./commands.ts";

interface CatalogEntry {
  command?: CustomCommand;
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

  private async catalog() {
    const catalog = new Map<string, CatalogEntry>();
    for (const store of this.stores) {
      const list = await store.list();
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

  async listCommands(print = false) {
    const list = [];
    for (const [name, { command }] of await this.catalog()) {
      if (!command?.enabled || builtinNames.has(name) || (print && command.disableNonInteractive)) continue;
      const plan = prepareCustomCommandPrompt(command, "");
      if (!plan.parts.some((part) => part.kind === "shell"))
        list.push({ name, description: command.description ?? "" });
    }
    return list;
  }

  async prepare(text: string, options: { skill?: string; print?: boolean; literal?: boolean }) {
    const match = !options.literal && /^\s*\/([\w:-]+(?:\/[\w:-]+)*)(?:\s+([\s\S]*))?$/.exec(text);
    let body = text;
    let initial: CustomCommand | undefined;
    let commandName: string | undefined;
    let required: string[] = [];
    if (match) {
      commandName = key(match[1]).replaceAll(":", "/");
      if (builtinNames.has(commandName)) {
        if (commandName !== "init" && commandName !== "compact")
          throw new Error(`/${commandName} 需要在交互终端中使用`);
        if (commandName === "compact" && options.skill) throw new Error("/compact 不接收 Skill");
        body = `/${commandName}${match[2] ? ` ${match[2]}` : ""}`;
      } else {
        const entry = (await this.catalog()).get(commandName);
        if (entry?.problem) throw new Error(entry.problem);
        initial = entry?.command;
        if (!initial && match[1].includes("/")) return { text, compact: false };
        if (!initial) throw new Error(`未知命令 /${commandName}。用 /help 查看可用命令。`);
        if (!initial.enabled) throw new Error(`命令已禁用：${initial.filePath}`);
        if (options.print && initial.disableNonInteractive)
          throw new Error(`此命令仅支持交互模式：${initial.filePath}`);
        const plan = prepareCustomCommandPrompt(initial, match[2] ?? "", initial.filePath);
        const fragments = plan.parts.map((part) => {
          if (part.kind === "shell") throw new Error(`此命令需要桌面端：${initial?.filePath}`);
          return part.text;
        });
        body = [
          `Run custom command /${plan.name}.`,
          `Command source: ${plan.source}.`,
          "",
          fragments.join("").trim(),
        ].join("\n");
        required = initial.skills ?? [];
      }
    }
    const skills = new Set([...required, ...(options.skill ? [options.skill] : [])]);
    if (skills.size) await this.skills.reload();
    for (const name of skills) {
      const skill = await this.skills.loadSkill(name);
      body += `\n\nRequired skill: ${skill.name}\nSkill source: ${skill.path}\n${skill.body}`;
    }
    const verify =
      initial && commandName
        ? async () => {
            const current = (await this.catalog()).get(key(initial.name))?.command;
            if (
              !current?.enabled ||
              current.revision !== initial.revision ||
              current.filePath !== initial.filePath ||
              current.importedSourcePath !== initial.importedSourcePath
            )
              throw new Error(`命令文件在准备期间已更改，请重试：${initial.filePath}`);
          }
        : undefined;
    return { text: body, verify, compact: commandName === "compact" };
  }
}

export async function fileContext(cwd: string, paths: string[] = []): Promise<InputContext> {
  const context: Required<Pick<InputContext, "fileReferences" | "images">> = {
    fileReferences: [],
    images: [],
  };
  let pixels = 0;
  for (const supplied of new Set(paths)) {
    const path = await realpath(resolve(cwd, supplied));
    const name = relative(cwd, path);
    if (name === ".." || name.startsWith(`..${sep}`) || isAbsolute(name))
      throw new Error("引用必须位于当前目录中");
    const info = await stat(path);
    if (info.isDirectory()) context.fileReferences.push(`${name || "."}/`);
    else if (!info.isFile()) throw new Error(`无法引用特殊文件：${name}`);
    else if (/^\.(png|jpe?g|webp|gif|bmp)$/i.test(extname(path))) {
      if (context.images.length >= imageLimits.count) throw new Error("本条消息图片数量超限");
      const data = await readFileBounded(path, imageLimits.sourceBytes);
      const metadata = await validateImageSource(data);
      pixels += metadata.width * metadata.height;
      if (pixels > imageLimits.messagePixels) throw new Error("本条消息图片总像素超限");
      const image = await prepareInlineImage(data, metadata.mimeType);
      if (!image.ok) throw new Error(image.message);
      context.images.push({ type: "image", mimeType: image.mimeType, data: image.data });
    } else context.fileReferences.push(name);
  }
  return context;
}
