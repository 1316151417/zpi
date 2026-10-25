import { expect, it } from "vitest";
import type { AssistantMessage } from "zpi-ai";
import { emptyAssistant } from "zpi-ai";
import { fakeModel } from "../../../tests/fake-server.ts";
import { serializeConversation } from "../src/core/compaction-utils.ts";

it.each([
  { name: "no text blocks", content: [], expected: "" },
  { name: "empty text", content: [{ type: "text", text: "" }], expected: "" },
  { name: "whitespace", content: [{ type: "text", text: " \n\t " }], expected: "" },
  {
    name: "several empty blocks",
    content: [
      { type: "text", text: "" },
      { type: "text", text: "" },
    ],
    expected: "",
  },
  {
    name: "visible text",
    content: [
      { type: "text", text: "  keep this\n" },
      { type: "text", text: "second block" },
    ],
    expected: "[Assistant]:   keep this\n\nsecond block",
  },
] satisfies { name: string; content: AssistantMessage["content"]; expected: string }[])(
  "serializes $name without adding empty assistant labels",
  ({ content, expected }) => {
    expect(serializeConversation([{ ...emptyAssistant(fakeModel("")), content }])).toBe(expected);
  },
);

it("keeps thinking and tool declarations when the assistant text is blank", () => {
  const message: AssistantMessage = {
    ...emptyAssistant(fakeModel("")),
    content: [
      { type: "thinking", thinking: "Inspect the file" },
      { type: "text", text: "" },
      { type: "toolCall", id: "read", name: "read", arguments: { path: "file.ts" } },
    ],
  };
  expect(serializeConversation([message])).toBe(
    '[Assistant thinking]: Inspect the file\n\n[Assistant tool calls]: read(path="file.ts")',
  );
});
