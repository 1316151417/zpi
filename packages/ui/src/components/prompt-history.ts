// Match ZCode's workspace history: 30 entries, consecutive duplicate suppression.
const limit = 30;
const key = (workspace: string) => `ZPI-chat-prompt-history:${workspace}`;
export function readPromptHistory(workspace: string, seed: readonly string[] = []): string[] {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(key(workspace)) ?? "null");
    if (Array.isArray(stored))
      return stored
        .filter((text): text is string => typeof text === "string" && Boolean(text.trim()))
        .slice(-limit);
  } catch {
    /* Storage is optional; history navigation still works in memory. */
  }
  return seed.reduce((entries, text) => appendPromptHistory(entries, text), [] as string[]);
}
export function appendPromptHistory(entries: readonly string[], text: string): string[] {
  const trimmed = text.trim();
  return !trimmed || entries.at(-1)?.trim() === trimmed ? [...entries] : [...entries, trimmed].slice(-limit);
}
export function savePromptHistory(workspace: string, entries: readonly string[]): void {
  try {
    localStorage.setItem(key(workspace), JSON.stringify(entries));
  } catch {
    /* A full or unavailable localStorage must not fail an accepted submission. */
  }
}
