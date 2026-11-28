import { readdir, realpath } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import type { AutocompleteItem, AutocompleteProvider, SlashCommand } from "@earendil-works/pi-tui";
import { buildMentionMarkdown, parseMentions } from "@zpi-dev/coding-agent";
import { isPathInside } from "../../../desktop/src/main/path-bounds.ts";
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

type ListCommands = () => readonly SlashCommand[] | Promise<readonly SlashCommand[]>;
const filePrefix = /(?:^|\s)(@(?:"[^"]*|[^\s"@]*))$/u;

export class Completions implements AutocompleteProvider {
  triggerCharacters = ["/", "@"];
  private cwd: string;
  private listCommands: ListCommands;
  private commandList?: { expires: number; commands: ReturnType<ListCommands> };

  constructor(cwd: string, listCommands: ListCommands) {
    this.cwd = cwd;
    this.listCommands = listCommands;
  }
  async getSuggestions(lines: string[], row: number, col: number, { signal }: { signal: AbortSignal }) {
    const before = lines[row].slice(0, col);
    if (lines.length === 1 && /^\/\S*$/u.test(before)) {
      // Reuse one catalog while the user types a command name. Execution reads the files again.
      const now = Date.now();
      if (before === "/" || !this.commandList || now >= this.commandList.expires)
        this.commandList = { expires: now + 1000, commands: this.listCommands() };
      const commands = await this.commandList.commands;
      if (signal.aborted) return null;
      const items = commands
        .filter(({ name }) => name.startsWith(before.slice(1)))
        .map(({ name, description }) => ({
          value: name,
          label: `/${safeText(name)}`,
          description: description && safeText(description).replaceAll("\n", " "),
        }));
      return items.length ? { prefix: before, items } : null;
    }
    this.commandList = undefined;
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
    return filePrefix.test(lines[row].slice(0, col));
  }
  applyCompletion(lines: string[], row: number, col: number, item: AutocompleteItem, prefix: string) {
    this.commandList = undefined;
    const isCommand = prefix.startsWith("/");
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
