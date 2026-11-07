import { DatabaseSync } from "node:sqlite";
import { afterEach } from "vitest";
import { HistoryIndex } from "../../src/main/history-index.ts";

const readers: DatabaseSync[] = [];
afterEach(() => {
  for (const reader of readers.splice(0)) reader.close();
});
/** Inspect or change facts with a separate derived cache, as the desktop does. */
export function isolatedHistory(path: string): HistoryIndex {
  const database = new DatabaseSync(":memory:");
  readers.push(database);
  return new HistoryIndex(path, database);
}
