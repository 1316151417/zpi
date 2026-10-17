import { createHash, randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import fs from "node:fs/promises";
import { basename, dirname, isAbsolute, join, parse, resolve, sep } from "node:path";
import type {
  CustomCommand,
  CustomCommandDelete,
  CustomCommandDiagnostic,
  CustomCommandInput,
  CustomCommandSetEnabled,
  CustomCommandsList,
  CustomCommandUpdate,
} from "../shared/custom-commands.ts";

interface MarkdownParts {
  frontmatter: string[];
  prompt: string;
}
export interface ParsedCustomCommandMarkdown {
  prompt: string;
  description?: string;
  argumentHint?: string;
  skills?: string[];
  disableNonInteractive?: boolean;
}
export interface CustomCommandLimits {
  maxFileBytes: number;
  maxCommands: number;
  maxEntries: number;
  maxDepth: number;
  maxTotalBytes: number;
}
export interface CustomCommandsStoreOptions {
  rootDirectory: string;
  stateFilePath: string;
  limits?: Partial<CustomCommandLimits>;
  /** Trusted main-process importer provenance; never supplied by the renderer. */
  importedLinkTargets?: () => Promise<ReadonlyMap<string, string>>;
}
const defaultLimits: CustomCommandLimits = {
  maxFileBytes: 256 * 1024,
  maxCommands: 1000,
  maxEntries: 10000,
  maxDepth: 8,
  maxTotalBytes: 16 * 1024 * 1024,
};
const maxStateBytes = 1024 * 1024;
const maxDisabledIds = 10000;
const managedKeys = new Set(["description", "argument-hint"]);

function fail(code: string, message: string): never {
  throw new Error(`${code}: ${message}`);
}
function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}
function keyLine(line: string): RegExpExecArray | null {
  return /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
}
function splitMarkdown(content: string): MarkdownParts {
  const lines = content.replace(/^\uFEFF/, "").split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return { frontmatter: [], prompt: content.trim() };
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  if (end < 0) fail("invalid_frontmatter", "Opening frontmatter fence has no closing fence");
  return {
    frontmatter: lines.slice(1, end),
    prompt: lines
      .slice(end + 1)
      .join("\n")
      .trim(),
  };
}
function scalar(value: string): string {
  value = value.trim();
  if (value.startsWith('"') && value.endsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(value);
      if (typeof parsed === "string") return parsed;
    } catch {
      // YAML's unrecognized escapes remain visible rather than losing user content.
    }
  }
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1).replaceAll("''", "'");
  return value;
}
function metadataValue(lines: string[], wanted: string): string | undefined {
  const index = lines.findIndex((line) => keyLine(line)?.[1].toLowerCase() === wanted);
  if (index < 0) return undefined;
  const initial = keyLine(lines[index])?.[2] ?? "";
  const block = /^[|>][-+]?\d?$/.test(initial);
  const continuation: string[] = [];
  for (let i = index + 1; i < lines.length; i++) {
    if (/^[^\s#]/.test(lines[i])) break;
    if (/^\s+\S/.test(lines[i]) && (block || !/^\s*#/.test(lines[i]))) continuation.push(lines[i].trim());
  }
  const value = block
    ? continuation.join(initial.startsWith("|") ? "\n" : " ")
    : [scalar(initial), ...continuation].filter(Boolean).join(" ");
  return value.trim() || undefined;
}
function flatMetadataValue(lines: string[], wanted: string): string | undefined {
  const index = lines.findIndex((line) => keyLine(line)?.[1].toLowerCase() === wanted);
  if (index < 0) return undefined;
  const value = keyLine(lines[index])?.[2] ?? "";
  if (wanted === "skills") {
    const next = lines.slice(index + 1).find((line) => line.trim() && !/^\s*#/.test(line));
    if (next && /^\s*-(?:\s|$)/.test(next))
      fail("invalid_frontmatter", "Block skills lists are unsupported; use skills: [a, b]");
  }
  return value;
}
function skillNames(value: string | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  if (value.length > 8192) fail("invalid_frontmatter", "Command skills metadata exceeds the length limit");
  let names = scalar(value).trim();
  if (names.startsWith("[") || names.endsWith("]")) {
    if (!names.startsWith("[") || !names.endsWith("]"))
      fail("invalid_frontmatter", "Command skills list has unmatched brackets");
    names = names.slice(1, -1);
  }
  const skills = names
    .split(",")
    .map((name) => scalar(name.trim()).trim())
    .filter(Boolean);
  if (
    skills.length > 64 ||
    skills.some(
      (name) =>
        name.length > 128 ||
        [...name].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127),
    )
  )
    fail(
      "invalid_frontmatter",
      "Command skills must contain at most 64 names of 128 characters without controls",
    );
  return [...new Set(skills)];
}
/** Small, non-executing Markdown frontmatter reader; this is not a general YAML evaluator. */
export function parseCustomCommandMarkdown(content: string): ParsedCustomCommandMarkdown {
  const { frontmatter, prompt } = splitMarkdown(content);
  const skills = skillNames(flatMetadataValue(frontmatter, "skills"));
  const nonInteractive = flatMetadataValue(frontmatter, "disable-noninteractive");
  return {
    prompt,
    description: metadataValue(frontmatter, "description"),
    argumentHint: metadataValue(frontmatter, "argument-hint"),
    ...(skills === undefined ? {} : { skills }),
    ...(nonInteractive === undefined
      ? {}
      : { disableNonInteractive: ["true", "yes"].includes(scalar(nonInteractive).trim().toLowerCase()) }),
  };
}
export function validateCustomCommandName(name: string): string {
  if (typeof name !== "string") fail("invalid_input", "Command name must be text");
  const normalized = name.replace(/^\//, "");
  if (!/^[A-Za-z0-9_-]{1,50}$/.test(normalized))
    fail("invalid_input", "Use 1–50 letters, numbers, underscores, or hyphens for a command name");
  if (["init", "compact", "side", "btw"].includes(normalized.toLowerCase()))
    fail("invalid_input", "Command name is reserved for a built-in command");
  return normalized;
}
export function isCustomCommandId(id: unknown): id is string {
  return (
    typeof id === "string" &&
    Boolean(id) &&
    id.length <= 1024 &&
    !isAbsolute(id) &&
    !/[\\:]/.test(id) &&
    ![...id].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127) &&
    /\.md$/i.test(id) &&
    id.split("/").every((part) => part && !part.startsWith(".") && !part.endsWith(".") && !part.endsWith(" "))
  );
}
function validateId(id: string): string {
  if (!isCustomCommandId(id)) fail("invalid_input", "Invalid relative command path");
  return id;
}
function commandName(id: string): string {
  return `/${id.replace(/\.md$/i, "")}`;
}
function linkFingerprint(id: string, target: string): string {
  return fingerprint(`registered-command-link\0${id}\0${target}`);
}
function fingerprint(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}
function renderMarkdown(input: Omit<CustomCommandInput, "name">, previous = ""): string {
  if (!input || typeof input.prompt !== "string") fail("invalid_input", "Command prompt must be text");
  for (const value of [input.description, input.argumentHint]) {
    if (value !== undefined && (typeof value !== "string" || value.length > 10000))
      fail("invalid_input", "Command metadata must be text of at most 10000 characters");
  }
  const preserved: string[] = [];
  let replaced = false;
  for (const line of splitMarkdown(previous).frontmatter) {
    const key = keyLine(line)?.[1].toLowerCase();
    if (key) replaced = managedKeys.has(key);
    else if (/^[^\s#]/.test(line)) replaced = false;
    // Comments and blank lines are independent of the managed value being replaced.
    if (!replaced || /^(?:\s*#|\s*$)/.test(line)) preserved.push(line);
  }
  if (input.description?.trim()) preserved.push(`description: ${JSON.stringify(input.description.trim())}`);
  if (input.argumentHint?.trim())
    preserved.push(`argument-hint: ${JSON.stringify(input.argumentHint.trim())}`);
  if (
    !preserved.length &&
    input.prompt
      .replace(/^\uFEFF/, "")
      .split(/\r?\n/, 1)[0]
      ?.trim() === "---"
  )
    return `---\n---\n\n${input.prompt}`;
  return preserved.length ? `---\n${preserved.join("\n")}\n---\n\n${input.prompt}` : input.prompt;
}
function diagnostic(error: unknown, path?: string): CustomCommandDiagnostic {
  const message = error instanceof Error ? error.message : String(error);
  return { code: /^([a-z_]+):/.exec(message)?.[1] ?? "read_error", message, ...(path ? { path } : {}) };
}
/** Checks every existing path component, including ancestors above the configured root. */
async function safeDirectory(path: string, create = false): Promise<boolean> {
  const absolute = resolve(path);
  let current = parse(absolute).root;
  for (const component of absolute.slice(current.length).split(sep).filter(Boolean)) {
    current = join(current, component);
    let stat: Stats;
    try {
      stat = await fs.lstat(current);
    } catch (error) {
      if (!isMissing(error)) throw error;
      if (!create) return false;
      try {
        await fs.mkdir(current, { mode: 0o700 });
      } catch (mkdirError) {
        if ((mkdirError as NodeJS.ErrnoException).code !== "EEXIST") throw mkdirError;
      }
      stat = await fs.lstat(current);
    }
    if (stat.isSymbolicLink() || !stat.isDirectory())
      fail("unsafe_path", "Command path contains a symlink or non-directory ancestor");
  }
  return true;
}
async function readRegularFile(path: string, maxBytes: number): Promise<string> {
  if (!(await safeDirectory(dirname(path)))) fail("not_found", "Command directory no longer exists");
  const before = await fs.lstat(path);
  if (before.isSymbolicLink() || !before.isFile() || before.nlink > 1)
    fail("unsafe_path", "Command storage only accepts regular, unlinked files");
  const handle = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink > 1 || stat.dev !== before.dev || stat.ino !== before.ino)
      fail("unsafe_path", "Command file changed identity while being opened");
    if (stat.size > maxBytes) fail("file_limit", "Command file exceeds the byte limit");
    let buffer = Buffer.alloc(Math.min(stat.size + 1, maxBytes + 1));
    let length = 0;
    while (length < buffer.length) {
      const result = await handle.read(buffer, length, buffer.length - length, length);
      if (!result.bytesRead) break;
      length += result.bytesRead;
      if (length === buffer.length && length <= maxBytes) {
        const expanded = Buffer.alloc(Math.min(buffer.length * 2, maxBytes + 1));
        buffer.copy(expanded);
        buffer = expanded;
      }
    }
    if (length > maxBytes) fail("file_limit", "Command file exceeds the byte limit");
    const after = await handle.stat();
    if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs)
      fail("conflict", "Command file changed while being read; reload it");
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buffer.subarray(0, length));
  } finally {
    await handle.close();
  }
}
interface ReadCommand {
  content: string;
  command: CustomCommand;
  diagnostic?: CustomCommandDiagnostic;
}

export class CustomCommandsStore {
  readonly rootDirectory: string;
  readonly stateFilePath: string;
  private readonly limits: CustomCommandLimits;
  private readonly importedLinkTargets?: CustomCommandsStoreOptions["importedLinkTargets"];
  private pending: Promise<unknown> = Promise.resolve();

  constructor(options: CustomCommandsStoreOptions) {
    if (!isAbsolute(options.rootDirectory) || !isAbsolute(options.stateFilePath))
      fail("invalid_input", "Command storage requires explicit absolute paths");
    this.rootDirectory = resolve(options.rootDirectory);
    this.stateFilePath = resolve(options.stateFilePath);
    this.limits = { ...defaultLimits, ...options.limits };
    for (const key of Object.keys(defaultLimits) as (keyof CustomCommandLimits)[]) {
      if (
        !Number.isSafeInteger(this.limits[key]) ||
        this.limits[key] < 1 ||
        this.limits[key] > defaultLimits[key]
      )
        fail("invalid_input", "Command storage limits must be positive and within the default safety caps");
    }
    if (this.stateFilePath === this.rootDirectory || /\.md$/i.test(this.stateFilePath))
      fail("invalid_input", "Enabled state must use a separate non-Markdown file");
    this.importedLinkTargets = options.importedLinkTargets;
  }
  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.pending.then(operation);
    this.pending = result.catch(() => undefined);
    return result;
  }
  private path(id: string): string {
    return join(this.rootDirectory, ...validateId(id).split("/"));
  }
  private async readCommand(
    id: string,
    disabled: ReadonlySet<string>,
    maxBytes = this.limits.maxFileBytes,
    onRead?: (bytes: number) => void,
    allowUnreadable = false,
  ): Promise<ReadCommand> {
    const filePath = this.path(id);
    if (!(await safeDirectory(dirname(filePath)))) fail("not_found", "Command directory no longer exists");
    let importedSourcePath: string | undefined;
    let linkTarget: string | undefined;
    const stat = await fs.lstat(filePath);
    if (stat.isSymbolicLink()) {
      const approved = (await this.importedLinkTargets?.())?.get(id);
      const target = await fs.readlink(filePath);
      linkTarget = target;
      if (!approved || !isAbsolute(approved) || resolve(dirname(filePath), target) !== resolve(approved))
        fail("unsafe_path", "Command symlink was not registered by the explicit importer");
      importedSourcePath = resolve(approved);
      if (!/\.md$/i.test(importedSourcePath)) fail("unsafe_path", "Imported command source is not Markdown");
    }
    const metadata = {
      id,
      name: commandName(id),
      filePath,
      ...(importedSourcePath ? { importedSourcePath } : {}),
      enabled: !disabled.has(id),
    };
    try {
      const content = await readRegularFile(importedSourcePath ?? filePath, maxBytes);
      onRead?.(Buffer.byteLength(content));
      return {
        content,
        command: { ...metadata, ...parseCustomCommandMarkdown(content), revision: fingerprint(content) },
      };
    } catch (error) {
      if (!allowUnreadable || !importedSourcePath || linkTarget === undefined) throw error;
      return {
        content: "",
        command: {
          ...metadata,
          enabled: false,
          prompt: "",
          unreadable: true,
          revision: linkFingerprint(id, linkTarget),
        },
        diagnostic: diagnostic(error, filePath),
      };
    }
  }
  private async assertNameAvailable(id: string): Promise<void> {
    const target = this.path(id);
    if (!(await safeDirectory(dirname(target)))) return;
    const name = basename(target).toLowerCase();
    let count = 0;
    const entries = await fs.opendir(dirname(target));
    for await (const entry of entries) {
      if (++count > this.limits.maxEntries)
        fail("scan_limit", "Cannot safely check command-name conflicts in this directory");
      if (entry.name.toLowerCase() === name)
        fail("conflict", "Command name already exists (names are case-insensitive)");
    }
  }

  private async readState(): Promise<Set<string>> {
    let raw: string;
    if (!(await safeDirectory(dirname(this.stateFilePath)))) return new Set();
    try {
      raw = await readRegularFile(this.stateFilePath, maxStateBytes);
    } catch (error) {
      if (isMissing(error)) return new Set();
      throw error;
    }
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      fail("invalid_state", "Command enabled state is not valid JSON; the original has been kept");
    }
    if (
      !value ||
      typeof value !== "object" ||
      !("version" in value) ||
      value.version !== 1 ||
      !("disabled" in value) ||
      !Array.isArray(value.disabled) ||
      value.disabled.length > maxDisabledIds ||
      value.disabled.some((id: unknown) => typeof id !== "string")
    )
      fail("invalid_state", "Command enabled state has an unsupported format; the original has been kept");
    for (const id of value.disabled) validateId(id);
    return new Set(value.disabled);
  }
  private async writeState(disabled: Set<string>): Promise<void> {
    if (disabled.size > maxDisabledIds) fail("state_limit", "Too many command enable overrides");
    await safeDirectory(dirname(this.stateFilePath), true);
    const value = `${JSON.stringify({ version: 1, disabled: [...disabled].sort() }, null, 2)}\n`;
    if (Buffer.byteLength(value) > maxStateBytes) fail("state_limit", "Command enabled state is too large");
    await this.publish(this.stateFilePath, value, true, async () => {
      await this.readState();
    });
  }
  private async publish(
    target: string,
    content: string,
    replace: boolean,
    beforePublish: () => Promise<void>,
  ): Promise<void> {
    await safeDirectory(dirname(target), true);
    const temporary = join(dirname(target), `.command-${randomUUID()}.tmp`);
    const handle = await fs.open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    const identity = await handle.stat();
    const sameIdentity = (stat: Stats) =>
      stat.isFile() && !stat.isSymbolicLink() && stat.dev === identity.dev && stat.ino === identity.ino;
    const cleanup = async () => {
      try {
        if (!(await safeDirectory(dirname(temporary)))) return;
        if (sameIdentity(await fs.lstat(temporary))) await fs.unlink(temporary);
      } catch {
        // A failed cleanup must not mask the original error or delete a substituted file.
      }
    };
    try {
      try {
        await handle.writeFile(content, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      if (!(await safeDirectory(dirname(temporary)))) fail("not_found", "Staging directory no longer exists");
      if (!sameIdentity(await fs.lstat(temporary))) fail("unsafe_path", "Staged command changed identity");
      if ((await readRegularFile(temporary, Buffer.byteLength(content))) !== content)
        fail("conflict", "Staged command was modified before publication");
      await beforePublish();
      if (!(await safeDirectory(dirname(target)))) fail("not_found", "Command directory no longer exists");
      if (!sameIdentity(await fs.lstat(temporary))) fail("unsafe_path", "Staged command changed identity");
      if (replace) await fs.rename(temporary, target);
      else {
        try {
          await fs.link(temporary, target);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "EEXIST") fail("conflict", "Command already exists");
          throw error;
        }
      }
    } finally {
      await cleanup();
    }
  }
  private assertRevision(command: CustomCommand, expectedRevision: string): void {
    if (typeof expectedRevision !== "string" || !/^[a-f0-9]{64}$/.test(expectedRevision))
      fail("invalid_input", "A command revision is required");
    if (command.revision !== expectedRevision)
      fail("conflict", "Command changed on disk; reload it before saving or deleting");
  }
  private assertSize(content: string): void {
    if (Buffer.byteLength(content) > this.limits.maxFileBytes)
      fail("file_limit", "Command exceeds the byte limit");
  }
  list(): Promise<CustomCommandsList> {
    return this.serialize(async () => {
      const commands: CustomCommand[] = [];
      const diagnostics: CustomCommandDiagnostic[] = [];
      let disabled = new Set<string>();
      let stateInvalid = false;
      try {
        disabled = await this.readState();
      } catch (error) {
        stateInvalid = true;
        diagnostics.push(diagnostic(error, this.stateFilePath));
      }
      let entriesSeen = 0;
      let bytesRead = 0;
      let exhausted = false;
      let entryLimitReached = false;
      const visit = async (directory: string, prefix: string, depth: number): Promise<void> => {
        if (!(await safeDirectory(directory))) return;
        const entries: string[] = [];
        const iterator = await fs.opendir(directory);
        for await (const entry of iterator) {
          entriesSeen++;
          if (entriesSeen > this.limits.maxEntries) {
            exhausted = true;
            entryLimitReached = true;
            diagnostics.push({
              code: "scan_limit",
              message: "Command scan entry limit reached",
              path: directory,
            });
            break;
          }
          if (!entry.name.startsWith(".")) entries.push(entry.name);
        }
        for (const entry of entries.sort()) {
          if (exhausted) break;
          if (commands.length >= this.limits.maxCommands || bytesRead >= this.limits.maxTotalBytes) {
            exhausted = true;
            diagnostics.push({
              code: "scan_limit",
              message: "Command scan size limit reached",
              path: directory,
            });
            break;
          }
          const path = join(directory, entry);
          try {
            await safeDirectory(directory);
            const stat = await fs.lstat(path);
            const id = prefix ? `${prefix}/${entry}` : entry;
            if (stat.isDirectory()) {
              if (depth >= this.limits.maxDepth) {
                diagnostics.push({
                  code: "scan_limit",
                  message: "Command directory depth limit reached",
                  path,
                });
              } else if (!exhausted) await visit(path, id, depth + 1);
            } else if (/\.md$/i.test(entry)) {
              const read = await this.readCommand(
                id,
                disabled,
                Math.min(this.limits.maxFileBytes, this.limits.maxTotalBytes - bytesRead),
                (bytes) => {
                  bytesRead += bytes;
                },
                true,
              );
              if (read.diagnostic) diagnostics.push(read.diagnostic);
              if (bytesRead > this.limits.maxTotalBytes) {
                exhausted = true;
                diagnostics.push({ code: "scan_limit", message: "Command scan byte limit reached", path });
                break;
              }
              if (stateInvalid) read.command.enabled = false;
              commands.push(read.command);
            } else if (stat.isSymbolicLink()) {
              diagnostics.push({
                code: "unsafe_path",
                message: "Skipped symlink directory or non-command",
                path,
              });
            }
          } catch (error) {
            diagnostics.push(diagnostic(error, path));
          }
        }
      };
      try {
        await visit(this.rootDirectory, "", 0);
      } catch (error) {
        diagnostics.push(diagnostic(error, this.rootDirectory));
      }
      if (entryLimitReached) commands.length = 0;
      commands.sort((a, b) =>
        a.name < b.name ? -1 : a.name > b.name ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
      );
      const selected = new Map<string, CustomCommand>();
      for (const command of commands) {
        const key = command.name.toLowerCase();
        if (selected.has(key)) {
          diagnostics.push({
            code: "duplicate_name",
            message: `Skipped duplicate command ${command.name}; names are case-insensitive`,
            path: command.filePath,
          });
        } else {
          selected.set(key, command);
          if (
            !/^\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/.test(command.name) ||
            ["/init", "/compact", "/side", "/btw"].includes(command.name.toLowerCase())
          )
            diagnostics.push({
              code: "unsupported_name",
              message: `Command ${command.name} can be edited but its name is not supported by slash invocation`,
              path: command.filePath,
            });
        }
      }
      return { commands: [...selected.values()], diagnostics, directoryPath: this.rootDirectory };
    });
  }
  create(input: CustomCommandInput): Promise<CustomCommand> {
    return this.serialize(async () => {
      const id = `${validateCustomCommandName(input?.name)}.md`;
      const target = this.path(id);
      const content = renderMarkdown(input);
      this.assertSize(content);
      const disabled = await this.readState();
      await safeDirectory(this.rootDirectory, true);
      await this.assertNameAvailable(id);
      if (disabled.delete(id)) await this.writeState(disabled);
      await this.publish(target, content, false, async () => {
        await this.assertNameAvailable(id);
      });
      return (await this.readCommand(id, disabled)).command;
    });
  }
  update(input: CustomCommandUpdate): Promise<CustomCommand> {
    return this.serialize(async () => {
      const disabled = await this.readState();
      const existing = await this.readCommand(input.id, disabled);
      this.assertRevision(existing.command, input.expectedRevision);
      const name = input.name;
      const id =
        name === undefined || name === existing.command.name || `/${name}` === existing.command.name
          ? input.id
          : `${validateCustomCommandName(name)}.md`;
      const source = existing.command.importedSourcePath;
      if (source) {
        if (input.confirmLinkedSource !== true || input.expectedSourcePath !== source)
          fail(
            "confirmation_required",
            "Saving this linked command modifies its source; confirm the exact source path",
          );
        if (id !== input.id)
          fail("invalid_input", "A linked command cannot be renamed while editing its source");
      } else if (input.expectedSourcePath !== undefined) {
        fail("conflict", "Command is no longer linked to the expected source; reload it");
      }
      const target = source ?? this.path(id);
      const content = renderMarkdown(input, existing.content);
      this.assertSize(content);
      if (id !== input.id) {
        await this.assertNameAvailable(id);
        // Keep the old override through failures; a later create explicitly resets its own ID.
        const changed = disabled.has(input.id) ? !disabled.has(id) : disabled.has(id);
        if (disabled.has(input.id)) disabled.add(id);
        else disabled.delete(id);
        if (changed) await this.writeState(disabled);
      }
      await this.publish(target, content, id === input.id, async () => {
        if (id !== input.id) await this.assertNameAvailable(id);
        const current = (await this.readCommand(input.id, disabled)).command;
        this.assertRevision(current, input.expectedRevision);
        if (current.importedSourcePath !== source)
          fail("conflict", "Command link target changed; reload it before saving");
      });
      if (id !== input.id) {
        try {
          this.assertRevision((await this.readCommand(input.id, disabled)).command, input.expectedRevision);
          await safeDirectory(dirname(existing.command.filePath));
          await fs.unlink(existing.command.filePath);
        } catch (error) {
          if (await safeDirectory(dirname(target)).catch(() => false))
            await fs.unlink(target).catch(() => undefined);
          throw error;
        }
      }
      return (await this.readCommand(id, disabled)).command;
    });
  }
  delete(input: CustomCommandDelete): Promise<void> {
    return this.serialize(async () => {
      const path = this.path(input.id);
      if (!(await safeDirectory(dirname(path)))) fail("not_found", "Command directory no longer exists");
      const stat = await fs.lstat(path);
      if (stat.isSymbolicLink()) {
        const target = await fs.readlink(path);
        const approved = (await this.importedLinkTargets?.())?.get(input.id);
        if (!approved || !isAbsolute(approved) || resolve(dirname(path), target) !== resolve(approved))
          fail("unsafe_path", "Command symlink was not registered by the explicit importer");
        if (input.expectedRevision === linkFingerprint(input.id, target)) {
          await safeDirectory(dirname(path));
          if ((await fs.readlink(path)) !== target) fail("conflict", "Command link changed before deletion");
          await fs.unlink(path);
          return;
        }
      }
      const existing = await this.readCommand(input.id, new Set());
      this.assertRevision(existing.command, input.expectedRevision);
      await safeDirectory(dirname(existing.command.filePath));
      await fs.unlink(existing.command.filePath);
    });
  }
  setEnabled(input: CustomCommandSetEnabled): Promise<CustomCommand> {
    return this.serialize(async () => {
      if (typeof input?.enabled !== "boolean") fail("invalid_input", "Enabled must be a boolean");
      const disabled = await this.readState();
      const { command } = await this.readCommand(input.id, disabled);
      if (input.enabled) disabled.delete(input.id);
      else disabled.add(input.id);
      await this.writeState(disabled);
      return { ...command, enabled: input.enabled };
    });
  }
}
