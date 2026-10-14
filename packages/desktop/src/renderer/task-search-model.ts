// Adapted from ZCode CommandCenterDialog (Apache-2.0).

import type { TaskSearchResult } from "../shared/bridge.ts";
import type { TaskSearchSnippet } from "../shared/task-search.ts";
import type { CommandCenterSearchScope } from "./task-search-history.ts";
export const searchScopePrefix = (scope: CommandCenterSearchScope) =>
  ({ all: "", commands: ">", conversations: "#", files: "@" })[scope];
export function resolveSearchScope(raw: string) {
  const trimmed = raw.trimStart();
  const prefixes: Partial<Record<string, CommandCenterSearchScope>> = {
    ">": "commands",
    "#": "conversations",
    "@": "files",
  };
  const scope = prefixes[trimmed[0]];
  return { query: scope ? trimmed.slice(1).trimStart() : raw.trim(), scope, explicit: Boolean(scope) };
}
export interface TaskSearchRow {
  key: string;
  task: TaskSearchResult;
  snippet?: TaskSearchSnippet;
}
export function taskSearchRows(tasks: readonly TaskSearchResult[], query: string) {
  const byId = new Map<string, TaskSearchResult>();
  for (const task of tasks) {
    const previous = byId.get(task.id);
    byId.set(task.id, previous ? { ...previous, snippets: [...previous.snippets, ...task.snippets] } : task);
  }
  return [...byId.values()].flatMap<TaskSearchRow>((task) => {
    const seen = new Set<string>();
    const snippets = query
      ? task.snippets.filter((snippet) => {
          const key = snippet.text
            .replace(/^\.{3}|\.{3}$/g, "")
            .replace(/\s+/g, " ")
            .trim()
            .toLocaleLowerCase();
          if (!key || seen.has(key)) return false;
          seen.add(key);
          return true;
        })
      : [];
    return snippets.length
      ? snippets.map((snippet, index) => ({ key: `${task.id}:${index}`, task, snippet }))
      : [{ key: task.id, task, snippet: undefined }];
  });
}
