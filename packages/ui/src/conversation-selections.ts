// Selection wire format and limits follow ZCode (Apache-2.0).
export interface ConversationSelection {
  text: string;
  path?: string;
  id?: string;
  sourceKey?: string;
  sourceTitle?: string;
  contentType?: "user" | "assistant" | "reasoning" | "tool" | "markdown";
}
export interface FileCommentSelection {
  path: string;
  title: string;
  start: number;
  end: number;
  comment: string;
  lineLabel: string;
}
const fileCommentPrefix = "file-comment:";

export function fileCommentSourceKey({
  start,
  end,
  comment,
}: Pick<FileCommentSelection, "start" | "end" | "comment">): string {
  return `${fileCommentPrefix}${JSON.stringify({ start, end, comment: comment.trim() })}`;
}

// 旧草稿已经用此 sourceKey 标记文件评论；不能凭路径或“第 N 行”误判普通引用。
export function getFileCommentSelection(reference: ConversationSelection): FileCommentSelection | null {
  if (!reference.path?.trim() || !reference.sourceKey?.startsWith(fileCommentPrefix)) return null;
  try {
    const value = JSON.parse(reference.sourceKey.slice(fileCommentPrefix.length));
    if (
      !value ||
      !Number.isSafeInteger(value.start) ||
      !Number.isSafeInteger(value.end) ||
      value.start < 1 ||
      value.end < value.start ||
      typeof value.comment !== "string"
    )
      return null;
    return {
      path: reference.path,
      title: reference.path.split(/[\\/]/).filter(Boolean).pop() ?? reference.path,
      start: value.start,
      end: value.end,
      comment: value.comment,
      lineLabel: value.start === value.end ? `L${value.start}` : `L${value.start}-L${value.end}`,
    };
  } catch {
    return null;
  }
}
export const selectionLimits = { count: 8, single: 8_000, total: 16_000 };
// 拖选链接后浏览器仍会派发 click；保留选区，避免同时打开文件或网页。
export function selectionIntersects(element: Element): boolean {
  const selection = element.ownerDocument.getSelection();
  return Boolean(
    selection &&
      !selection.isCollapsed &&
      selection.rangeCount > 0 &&
      selection.getRangeAt(0).intersectsNode(element),
  );
}
export function validSelections(value: unknown): value is ConversationSelection[] {
  return (
    Array.isArray(value) &&
    value.length <= selectionLimits.count &&
    value.every(
      (item) =>
        item &&
        typeof item === "object" &&
        !Array.isArray(item) &&
        typeof item.text === "string" &&
        item.text.length <= selectionLimits.single &&
        ["path", "id", "sourceKey", "sourceTitle"].every(
          (key) => item[key] === undefined || typeof item[key] === "string",
        ) &&
        (item.contentType === undefined ||
          ["user", "assistant", "reasoning", "tool", "markdown"].includes(item.contentType)),
    ) &&
    value.reduce((sum, item) => sum + item.text.length, 0) <= selectionLimits.total
  );
}
export function appendSelection(
  current: ConversationSelection[],
  reference: ConversationSelection,
): ConversationSelection[] {
  if (
    current.some(
      (item) =>
        item.sourceKey === reference.sourceKey &&
        item.text === reference.text &&
        item.path === reference.path,
    )
  )
    return current;
  if (reference.text.length > selectionLimits.single) throw new Error("单条引用最多 8,000 个字符。");
  if (current.length >= selectionLimits.count) throw new Error("最多可添加 8 条对话引用。");
  if (
    current.reduce((sum, item) => sum + item.text.length, 0) + reference.text.length >
    selectionLimits.total
  )
    throw new Error("对话引用总计最多 16,000 个字符。");
  return [...current, reference];
}
export function buildSelectionPrompt(text: string, references: readonly ConversationSelection[]): string {
  if (!references.length) return text;
  const block = [
    "# userselect:",
    "```userselect",
    JSON.stringify(
      references.map((reference) => {
        const { text, path, sourceKey, id } = reference;
        // 保留评论身份供发送后的附件恢复；完整选中代码仍在 text 中供模型读取。
        return getFileCommentSelection(reference)
          ? { path, text, sourceKey, ...(id ? { id } : {}) }
          : path?.trim()
            ? { path, text }
            : { text };
      }),
    ),
    "```",
  ].join("\n");
  return text ? `${text}\n\n${block}` : block;
}
export function parseSelectionPrompt(text: string): { text: string; selections: ConversationSelection[] } {
  const start = text.lastIndexOf("# userselect:\n```userselect\n");
  const match =
    start < 0 || (start > 0 && !text.slice(0, start).endsWith("\n\n"))
      ? null
      : /^# userselect:\n```userselect\n([\s\S]*?)\n```\s*$/.exec(text.slice(start));
  if (match) {
    try {
      const selections: unknown = JSON.parse(match[1]);
      if (
        Array.isArray(selections) &&
        selections.every(
          (item) =>
            item &&
            !Array.isArray(item) &&
            typeof item.text === "string" &&
            (item.path === undefined || (typeof item.path === "string" && item.path.trim())) &&
            (Object.keys(item).every((key) => key === "text" || key === "path") ||
              (typeof item.sourceKey === "string" &&
                (item.id === undefined || typeof item.id === "string") &&
                Object.keys(item).every((key) => ["text", "path", "sourceKey", "id"].includes(key)) &&
                getFileCommentSelection(item) !== null)),
        )
      )
        return { text: text.slice(0, start).trimEnd(), selections };
    } catch {
      /* Preserve malformed user text verbatim. */
    }
  }
  return { text, selections: [] };
}
