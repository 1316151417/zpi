import { readdir, realpath } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import type { AutocompleteItem, AutocompleteProvider, SlashCommand } from "@earendil-works/pi-tui";
import { buildMentionMarkdown, parseMentions } from "@zpi-dev/coding-agent";
import { isPathInside } from "../../../desktop/src/main/path-bounds.ts";
import { commandUsage } from "../host/commands.ts";
import { safeText } from "./theme.ts";

export function references(text: string) {
  return [
    ...new Set(
      parseMentions(text)
        .filter((m) => m.kind === "file" && m.markdown.startsWith("[@") && m.path.startsWith("./"))
        .map((m) => m.path),
    ),
  ];
}

type Command = SlashCommand & { kind?: "command" | "skill" };
type ListCommands = () => readonly Command[] | Promise<readonly Command[]>;
const filePrefix = /(?:^|\s)(@(?:"[^"]*|[^\s"@]*))$/u;
// Only one scalar argument is completed. Skills and commands with free text still use @file completion.
const argumentPrefix = /^\/(\S+)\s+(\S*)$/u;
export function submitsSlashArguments(beforeCursor: string) {
  return /^\/\S+\s/u.test(beforeCursor) && !filePrefix.test(beforeCursor);
}

export function withArgumentChoices(
  commands: readonly Command[],
  choices: Partial<Record<string, () => readonly string[] | Promise<readonly string[]>>>,
): Command[] {
  return commands.map((command) => {
    const load = choices[command.name];
    if (!load) return command;
    let values: Promise<readonly string[]> | undefined;
    return {
      ...command,
      async getArgumentCompletions(prefix: string) {
        // Keep one snapshot as the prefix changes. Submitting the command revalidates the selection.
        values ??= Promise.resolve()
          .then(load)
          .catch(() => []);
        const query = prefix.toLowerCase();
        return (await values)
          .filter((value) => value.toLowerCase().includes(query))
          .map((value) => ({ value, label: safeText(value) }));
      },
    };
  });
}

export class Completions implements AutocompleteProvider {
  triggerCharacters = ["/", "@"];
  private cwd: string;
  private listCommands: ListCommands;
  private commandList?: { expires: number; commands: ReturnType<ListCommands>; acceptedName?: string };

  constructor(cwd: string, listCommands: ListCommands) {
    this.cwd = cwd;
    this.listCommands = listCommands;
  }
  private catalog(fresh = false) {
    const now = Date.now();
    if (fresh || !this.commandList || now >= this.commandList.expires)
      this.commandList = { expires: now + 1000, commands: this.listCommands() };
    return this.commandList.commands;
  }
  async findCommand(name: string) {
    // The selected item already belongs to this catalog. A new search will refresh it.
    const commands = await (this.commandList?.acceptedName === name
      ? this.commandList.commands
      : this.catalog());
    return commands.find((command) => command.name === name);
  }
  async getSuggestions(lines: string[], row: number, col: number, { signal }: { signal: AbortSignal }) {
    const before = lines[row].slice(0, col);
    if (lines.length === 1 && /^\/\S*$/u.test(before)) {
      // Reuse one catalog while the user types a command name. Execution reads the files again.
      const commands = await this.catalog(before === "/");
      if (signal.aborted) return null;
      const query = before.slice(1);
      if (
        !/^\S/u.test(lines[row].slice(col)) &&
        commands.some((cmd) => cmd.name === query && cmd.kind === "skill")
      )
        return null;
      const items = commands
        .filter(({ name }) => name.startsWith(query))
        .map(({ name, description, argumentHint }) => ({
          value: name,
          label: safeText(commandUsage({ name, argumentHint })).replaceAll("\n", " "),
          description: description && safeText(description).replaceAll("\n", " "),
        }));
      return items.length ? { prefix: before, items } : null;
    }
    const args = lines.length === 1 && argumentPrefix.exec(before);
    if (args) {
      const [, name, prefix] = args;
      const catalog = await (this.commandList?.commands ?? this.catalog());
      const command = catalog.find((item) => item.name === name);
      if (command?.getArgumentCompletions) {
        if (signal.aborted) return null;
        const items = await command.getArgumentCompletions(prefix);
        return !signal.aborted && items?.length
          ? { prefix, items: items.map((item) => ({ ...item, argumentFor: name })) }
          : null;
      }
    }
    const prefix = filePrefix.exec(before)?.[1];
    if (!prefix) return null;
    const query = prefix.slice(prefix.startsWith('@"') ? 2 : 1);
    const slash = query.lastIndexOf("/");
    const directory = query.slice(0, slash + 1);
    const name = query.slice(slash + 1);
    if (isAbsolute(query) || query.split("/").includes("..")) return null;
    const folder = await realpath(resolve(this.cwd, directory)).catch(() => undefined);
    if (!folder || !isPathInside(this.cwd, folder) || signal.aborted) return null;
    const entries = await readdir(folder, { withFileTypes: true }).catch(() => []);
    const items = entries
      .filter(
        (entry) =>
          (entry.isFile() || entry.isDirectory() || entry.isSymbolicLink()) &&
          entry.name.startsWith(name) &&
          (!entry.name.startsWith(".") || name.startsWith(".")) &&
          safeText(entry.name) === entry.name &&
          !entry.name.includes("\n"),
      )
      .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
      .slice(0, 100)
      .map((entry) => {
        const value = directory.replace(/^\.\//, "") + entry.name + (entry.isDirectory() ? "/" : "");
        return { value, label: value };
      });
    return !signal.aborted && items.length ? { prefix, items } : null;
  }
  shouldTriggerFileCompletion(lines: string[], row: number, col: number) {
    const before = lines[row].slice(0, col);
    return filePrefix.test(before) || (lines.length === 1 && argumentPrefix.test(before));
  }
  applyCompletion(lines: string[], row: number, col: number, item: AutocompleteItem, prefix: string) {
    // A key can arrive while pi-tui is still replacing an older async menu.
    const before = lines[row].slice(0, col);
    if (!before.endsWith(prefix)) return { lines, cursorLine: row, cursorCol: col };
    if ("argumentFor" in item) {
      const args = argumentPrefix.exec(before);
      if (!args || args[1] !== item.argumentFor || args[2] !== prefix)
        return { lines, cursorLine: row, cursorCol: col };
      const head = before.slice(0, col - prefix.length) + item.value;
      const result = [...lines];
      result[row] = head + lines[row].slice(col).replace(/^\S+/u, "");
      return { lines: result, cursorLine: row, cursorCol: head.length };
    }
    const isCommand = prefix.startsWith("/");
    if (isCommand && this.commandList) {
      this.commandList.acceptedName = item.value;
      this.commandList.expires = 0;
    }
    const inserted = isCommand
      ? `/${item.value} `
      : `${buildMentionMarkdown(`@${item.value}`, `./${item.value}`)} `;
    const line = lines[row];
    const start = col - prefix.length;
    let tail = line.slice(col);
    if (isCommand) {
      const suffix = /^\S+/u.exec(tail)?.[0];
      if (suffix && item.value.startsWith(prefix.slice(1) + suffix)) tail = tail.slice(suffix.length);
      if (tail.startsWith(" ")) tail = tail.slice(1);
    }
    const result = [...lines];
    result[row] = line.slice(0, start) + inserted + tail;
    return { lines: result, cursorLine: row, cursorCol: start + inserted.length };
  }
}
