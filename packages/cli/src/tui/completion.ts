import { readdir, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import type { AutocompleteItem, AutocompleteProvider, SlashCommand } from "@earendil-works/pi-tui";
import { buildMentionMarkdown, parseMentions } from "@zpi-dev/coding-agent";
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

// A path is only attached after the user accepts its completion or supplies an explicit native mention.
type ListCommands = () => readonly SlashCommand[] | Promise<readonly SlashCommand[]>;

export class Completions implements AutocompleteProvider {
  triggerCharacters = ["/", "@"];
  private cwd: string;
  private listCommands: ListCommands;

  constructor(cwd: string, listCommands: ListCommands) {
    this.cwd = cwd;
    this.listCommands = listCommands;
  }
  async getSuggestions(lines: string[], row: number, col: number, { signal }: { signal: AbortSignal }) {
    const before = lines[row].slice(0, col);
    if (lines.length === 1 && /^\/[\w:/.-]*$/u.test(before)) {
      const items = (await this.listCommands())
        .filter(({ name }) => name.startsWith(before.slice(1)))
        .map(({ name, description }) => ({
          value: name,
          label: `/${safeText(name)}`,
          description: description && safeText(description).replaceAll("\n", " "),
        }));
      return items.length ? { prefix: before, items } : null;
    }
    const prefix = before.match(/(?:^|\s)(@(?:"[^"]*|[^\s"@]*))$/u)?.[1];
    if (!prefix) return null;
    const query = prefix.slice(prefix.startsWith('@"') ? 2 : 1);
    const slash = query.lastIndexOf("/");
    const directory = query.slice(0, slash + 1);
    const name = query.slice(slash + 1);
    if (isAbsolute(query) || query.split("/").includes("..")) return null;
    const folder = await realpath(resolve(this.cwd, directory)).catch(() => undefined);
    if (!folder || relative(this.cwd, folder).split("/").includes("..") || signal.aborted) return null;
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
    return /(?:^|\s)@(?:"[^"]*|[^\s"@]*)$/u.test(lines[row].slice(0, col));
  }
  applyCompletion(lines: string[], row: number, col: number, item: AutocompleteItem, prefix: string) {
    const inserted = prefix.startsWith("/")
      ? `/${item.value} `
      : `${buildMentionMarkdown(`@${item.value}`, `./${item.value}`)} `;
    const line = lines[row];
    const start = col - prefix.length;
    const result = [...lines];
    result[row] = line.slice(0, start) + inserted + line.slice(col);
    return { lines: result, cursorLine: row, cursorCol: start + inserted.length };
  }
}
