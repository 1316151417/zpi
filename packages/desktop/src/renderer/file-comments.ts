import {
  appendSelection,
  type ComposerDraftStore,
  type ConversationSelection,
  fileCommentSourceKey,
  getFileCommentSelection,
} from "zpi-ui";

export interface FileCommentRange {
  start: number;
  end: number;
}
export interface FileComment extends FileCommentRange {
  id: string;
  comment: string;
}
export function normalizeFileCommentRange(range: FileCommentRange, text: string): FileCommentRange {
  const count = text.split("\n").length;
  return {
    start: Math.max(1, Math.min(count, range.start, range.end)),
    end: Math.max(1, Math.min(count, Math.max(range.start, range.end))),
  };
}
export function createFileComment(
  path: string,
  text: string,
  range: FileCommentRange,
  comment: string,
  id: string,
): ConversationSelection {
  const normalized = normalizeFileCommentRange(range, text);
  const selected = text
    .split("\n")
    .slice(normalized.start - 1, normalized.end)
    .join("\n");
  if (!selected.trim()) throw new Error("请选择包含内容的代码行。");
  const label =
    normalized.start === normalized.end
      ? `第 ${normalized.start} 行`
      : `第 ${normalized.start}–${normalized.end} 行`;
  return {
    id,
    path,
    sourceKey: fileCommentSourceKey({ ...normalized, comment }),
    sourceTitle: `${path} · ${label}`,
    contentType: "tool",
    text: `${label}\n${selected}${comment.trim() ? `\n\n备注：${comment.trim()}` : ""}`,
  };
}
export function fileComments(selections: readonly ConversationSelection[], path: string): FileComment[] {
  return selections.flatMap((selection) => {
    const value = getFileCommentSelection(selection);
    return value && value.path === path && selection.id
      ? [{ id: selection.id, start: value.start, end: value.end, comment: value.comment }]
      : [];
  });
}
export function addFileCommentToDraft(
  store: ComposerDraftStore,
  sessionId: string,
  path: string,
  text: string,
  range: FileCommentRange,
  comment: string,
  id: string,
): void {
  const current = store.get(sessionId);
  if (!current) throw new Error("当前对话不可添加备注。");
  const reference = createFileComment(path, text, range, comment, id);
  store.set(sessionId, {
    ...current,
    selections: appendSelection(current.selections ?? [], reference),
    error: undefined,
  });
}
export function removeFileCommentFromDraft(store: ComposerDraftStore, sessionId: string, id: string): void {
  const current = store.get(sessionId);
  if (current)
    store.set(sessionId, {
      ...current,
      selections: current.selections?.filter((selection) => selection.id !== id),
    });
}
export { appendSelection };
