import { createElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import {
  SelectionReferenceChip,
  SelectionReferenceDetails,
} from "../src/components/ConversationSelections.tsx";
import {
  buildSelectionPrompt,
  type ConversationSelection,
  fileCommentSourceKey,
  getFileCommentSelection,
  parseSelectionPrompt,
  validSelections,
} from "../src/conversation-selections.ts";

const comment = (path = "/workspace/src/example.txt", start = 6, end = start, note = "请解释这里") => ({
  id: `${path}:${start}`,
  path,
  sourceKey: `file-comment:${JSON.stringify({ start, end, comment: note })}`,
  sourceTitle: `${path} · 第 ${start} 行`,
  contentType: "tool" as const,
  text: `第 ${start} 行\nSELECTED_CODE_MUST_STAY_IN_PROMPT\n\n备注：${note}`,
});
const quote = { text: "第 6 行\nordinary selection", path: "/workspace/quote.txt" };
function elements(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const element = node as ReactElement<{ children?: ReactNode }>;
  return [element as ReactElement<Record<string, unknown>>, ...elements(element.props.children)];
}
it("encodes the exact existing wire bytes and round-trips trimmed comments", () => {
  const sourceKey = fileCommentSourceKey({ comment: '  中文 "quote"\nsecond line  ', end: 9, start: 6 });
  expect(sourceKey).toBe(
    String.raw`file-comment:{"start":6,"end":9,"comment":"中文 \"quote\"\nsecond line"}`,
  );
  expect(getFileCommentSelection({ path: "/work/example.ts", text: "code", sourceKey })).toMatchObject({
    start: 6,
    end: 9,
    comment: '中文 "quote"\nsecond line',
  });
  expect(fileCommentSourceKey({ start: 1, end: 1, comment: " \n " })).toBe(
    'file-comment:{"start":1,"end":1,"comment":""}',
  );
});
it("recognizes saved file-comment drafts but never guesses ordinary quotations from path or line text", () => {
  expect(validSelections([comment(), quote])).toBe(true);
  expect(getFileCommentSelection(comment())).toMatchObject({
    title: "example.txt",
    lineLabel: "L6",
    comment: "请解释这里",
  });
  expect(getFileCommentSelection(comment("C:\\work\\nested\\main.ts", 6, 9))).toMatchObject({
    title: "main.ts",
    lineLabel: "L6-L9",
  });
  expect(getFileCommentSelection(quote)).toBeNull();
  for (const sourceKey of [
    "file-comment:null",
    "file-comment:{",
    'file-comment:{"start":0,"end":1,"comment":"x"}',
    'file-comment:{"start":2,"end":1,"comment":"x"}',
  ]) {
    expect(getFileCommentSelection({ ...comment(), sourceKey })).toBeNull();
  }
});
it("preserves complete model content and comment identity after send without changing ordinary quote wire", () => {
  const original = [comment(), quote, comment("/other/a.ts", 2, 4, "second comment")];
  const parsed = parseSelectionPrompt(buildSelectionPrompt("Review", original));
  expect(parsed.text).toBe("Review");
  expect(parsed.selections.map((item) => item.text)).toEqual(original.map((item) => item.text));
  expect(parsed.selections.map(getFileCommentSelection)).toEqual(original.map(getFileCommentSelection));
  expect(parsed.selections[0].id).toBe(comment().id);
  expect(parsed.selections[1]).toEqual(quote);
  expect(parseSelectionPrompt(buildSelectionPrompt("", original)).text).toBe("");
});
it("renders a separate aggregated comment pill in both composer and sent messages", () => {
  const refs = [comment(), quote, comment("/other/a.ts", 2, 4)];
  const composer = renderToStaticMarkup(
    createElement(SelectionReferenceChip, { references: refs, onChange: () => {} }),
  );
  expect(composer).toContain('aria-label="2 条评论"');
  expect(composer).toContain('aria-label="quote.txt · 引用"');
  expect(composer).toContain('aria-label="移除全部评论"');
  expect(composer).toContain("lucide-message-square-text");
  const sent = renderToStaticMarkup(
    createElement(SelectionReferenceChip, {
      references: parseSelectionPrompt(buildSelectionPrompt("", refs)).selections,
    }),
  );
  expect(sent).toContain('aria-label="2 条评论"');
  expect(sent).not.toContain("移除全部评论");
});
it("renders basename/range, secondary path and note instead of a selected-code summary in insertion order", () => {
  const refs = [comment(), comment("/other/a.ts", 2, 4, "second note"), comment("/empty/note.ts", 1, 1, "")];
  const html = renderToStaticMarkup(
    createElement(SelectionReferenceDetails, { references: refs, comments: true, onFile: () => {} }),
  );
  expect(html).toContain("<strong>example.txt</strong><span>L6</span>");
  expect(html).toContain("<strong>a.ts</strong><span>L2-L4</span>");
  expect(html).toContain('title="/workspace/src/example.txt"');
  expect(html).toContain("请解释这里");
  expect(html).not.toContain("SELECTED_CODE_MUST_STAY_IN_PROMPT");
  expect(html).not.toContain("第 6 行");
  expect(html.indexOf("example.txt")).toBeLessThan(html.indexOf("a.ts"));
  expect(html).toContain("lucide-code-xml");
});
it("removes only the requested comment group or item and navigates with the exact range", () => {
  const refs = [comment(), quote, comment("/other/a.ts", 2, 4)];
  const onChange = vi.fn();
  const onCommentsEmpty = vi.fn();
  const groups = elements(SelectionReferenceChip({ references: refs, onChange, onCommentsEmpty })).filter(
    (element) => Array.isArray(element.props.references),
  );
  const commentGroup = groups.find((element) => element.props.comments);
  if (!commentGroup) throw new Error("Missing comment group");
  const change = commentGroup.props.onChange as (refs: ConversationSelection[]) => void;
  change([]);
  expect(onChange).toHaveBeenLastCalledWith([quote]);
  expect(onCommentsEmpty).toHaveBeenCalledOnce();
  change([refs[2]]);
  expect(onChange).toHaveBeenLastCalledWith([quote, refs[2]]);
  expect(onCommentsEmpty).toHaveBeenCalledOnce();
  const onFile = vi.fn();
  const details = elements(
    SelectionReferenceDetails({ references: [refs[0], refs[2]], comments: true, onChange: change, onFile }),
  );
  const source = details.find((element) => element.props["aria-label"] === "打开 a.ts L2-L4");
  if (!source) throw new Error("Missing navigation button");
  (source.props.onClick as () => void)();
  expect(onFile).toHaveBeenCalledWith("/other/a.ts", { line: 2, endLine: 4 });
  const remove = details.find((element) => element.props["aria-label"] === "移除评论");
  if (!remove) throw new Error("Missing remove button");
  (remove.props.onClick as (event: { stopPropagation(): void }) => void)({ stopPropagation() {} });
  expect(onChange).toHaveBeenLastCalledWith([quote, refs[2]]);
});

it("leaves malformed comment envelopes visible and never promotes them to navigable comments", () => {
  for (const extra of [
    { sourceKey: "file-comment:null" },
    { sourceKey: 'file-comment:{"start":-1,"end":6,"comment":"x"}' },
    { sourceKey: 'file-comment:{"start":1,"end":1e100,"comment":"x"}' },
    { sourceKey: 'file-comment:{"start":1.5,"end":6,"comment":"x"}' },
    { sourceKey: 123 },
    { id: {} },
    { path: null },
    { path: "" },
    { surprise: "extra-field" },
  ]) {
    const raw = `# userselect:\n\`\`\`userselect\n${JSON.stringify([{ ...comment(), sourceTitle: undefined, contentType: undefined, ...extra }])}\n\`\`\``;
    expect(parseSelectionPrompt(raw)).toEqual({ text: raw, selections: [] });
  }
});
