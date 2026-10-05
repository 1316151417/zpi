import { expect, it } from "vitest";
import { messageTime } from "../src/components/MessageActions.tsx";
import {
  appendSelection,
  buildSelectionPrompt,
  parseSelectionPrompt,
  validSelections,
} from "../src/conversation-selections.ts";

it("selection wire format round trips quotes, code fences, newlines and optional source paths", () => {
  const selections = [
    {
      text: 'quoted "text"\n```ts\nconst a = 1;\n```',
      path: "/workspace/a.ts",
      id: "private-id",
      sourceKey: "private-source",
    },
  ];
  const prompt = buildSelectionPrompt("why?", selections);
  expect(prompt).toContain("# userselect:\n```userselect\n");
  expect(prompt).not.toContain("private-id");
  expect(prompt).not.toContain("private-source");
  expect(parseSelectionPrompt(prompt)).toEqual({
    text: "why?",
    selections: [{ text: selections[0].text, path: selections[0].path }],
  });
  expect(parseSelectionPrompt("# userselect:\n```userselect\n{broken}\n```").selections).toEqual([]);
  const unknownField = 'visible\n\n# userselect:\n```userselect\n[{"text":"quote","id":"unexpected"}]\n```';
  expect(parseSelectionPrompt(unknownField)).toEqual({ text: unknownField, selections: [] });
});
it("selection limits deduplicate by source and enforce count, single and total independently", () => {
  const item = { text: "quote", sourceKey: "row1" };
  expect(appendSelection([item], { ...item, id: "another" })).toEqual([item]);
  expect(appendSelection([item], { ...item, sourceKey: "row2" })).toHaveLength(2);
  expect(() => appendSelection([], { text: "a".repeat(8001) })).toThrow("8,000");
  expect(() =>
    appendSelection(
      Array.from({ length: 8 }, (_, i) => ({ text: String(i) })),
      { text: "ninth" },
    ),
  ).toThrow("8 条");
  expect(() =>
    appendSelection([{ text: "a".repeat(8000) }, { text: "b".repeat(8000) }], { text: "c" }),
  ).toThrow("16,000");
});
it("message time follows local calendar days, yesterday and year boundaries", () => {
  const now = new Date(2026, 9, 5, 12).getTime();
  expect(messageTime(new Date(2026, 9, 5, 9, 3).getTime(), now)).toBe("09:03");
  expect(messageTime(new Date(2026, 9, 4, 9, 3).getTime(), now)).toBe("昨天 09:03");
  expect(messageTime(new Date(2025, 9, 4, 9, 3).getTime(), now)).toContain("2025");
  expect(messageTime(Number.NaN, now)).toBe("");
});

it("draft references reject malformed metadata before it reaches rendering", () => {
  expect(validSelections([{ text: "quote", sourceTitle: "回复", contentType: "assistant" }])).toBe(true);
  for (const item of [
    null,
    ["quote"],
    { text: "quote", sourceTitle: {} },
    { text: "quote", sourceKey: 1 },
    { text: "quote", id: false },
    { text: "quote", contentType: "unknown" },
  ])
    expect(validSelections([item])).toBe(false);
});
