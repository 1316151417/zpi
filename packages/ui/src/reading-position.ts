export interface ReadingBookmark {
  top: number;
  following: boolean;
  cursor?: number;
  runId?: string;
  offset?: number;
}

export function readReadingBookmark(value: string | null): ReadingBookmark | null {
  try {
    const data = JSON.parse(value ?? "null");
    if (!data || typeof data.following !== "boolean" || !Number.isFinite(data.top) || data.top < 0)
      return null;
    const bookmark: ReadingBookmark = { top: data.top, following: data.following };
    if (Number.isSafeInteger(data.cursor) && data.cursor >= 0) bookmark.cursor = data.cursor;
    if (typeof data.runId === "string" && data.runId && Number.isFinite(data.offset)) {
      bookmark.runId = data.runId;
      bookmark.offset = data.offset;
    }
    return bookmark;
  } catch {
    return null;
  }
}

export function readingAnchor(root: HTMLElement): { runId: string; offset: number } | undefined {
  const top = root.getBoundingClientRect().top;
  for (const node of root.querySelectorAll<HTMLElement>("[data-history-run]")) {
    const bounds = node.getBoundingClientRect();
    if (bounds.bottom > top && node.dataset.historyRun)
      return { runId: node.dataset.historyRun, offset: top - bounds.top };
  }
}
