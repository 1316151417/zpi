// Selection wire format and limits follow ZCode (Apache-2.0).
export interface ConversationSelection {
  text: string;
  path?: string;
  id?: string;
  sourceKey?: string;
  sourceTitle?: string;
  contentType?: "user" | "assistant" | "reasoning" | "tool" | "markdown";
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
    JSON.stringify(references.map(({ text, path }) => (path?.trim() ? { path, text } : { text }))),
    "```",
  ].join("\n");
  return text ? `${text}\n\n${block}` : block;
}
export function parseSelectionPrompt(text: string): { text: string; selections: ConversationSelection[] } {
  const match = /(?:\n\n)?# userselect:\n```userselect\n([\s\S]*?)\n```\s*$/.exec(text);
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
            Object.keys(item).every((key) => key === "text" || key === "path"),
        )
      )
        return { text: text.slice(0, match.index).trimEnd(), selections };
    } catch {
      /* Preserve malformed user text verbatim. */
    }
  }
  return { text, selections: [] };
}
