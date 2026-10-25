import { expect, it } from "vitest";
import type { Message } from "zpi-ai";
import { emptyAssistant } from "zpi-ai";
import { fakeModel } from "../../../tests/fake-server.ts";
import { transformMessages } from "../src/api/transform-messages.ts";

it("pairs duplicate provider IDs in declaration order and keeps later turns independent", () => {
  const model = fakeModel("");
  const messages: Message[] = [
    {
      ...emptyAssistant(model),
      content: ["read", "write"].map((name) => ({ type: "toolCall", id: "same", name, arguments: {} })),
    },
    ...["read", "write"].map(
      (name): Message => ({
        role: "toolResult",
        toolCallId: "same",
        toolName: name,
        content: [{ type: "text", text: name }],
        isError: false,
        timestamp: 0,
      }),
    ),
    { ...emptyAssistant(model), content: [{ type: "toolCall", id: "same", name: "bash", arguments: {} }] },
    { role: "toolResult", toolCallId: "same", toolName: "bash", content: [], isError: false, timestamp: 0 },
  ];
  const before = structuredClone(messages);
  const result = transformMessages(messages, model);
  expect(result.filter((message) => message.role === "toolResult")).toMatchObject([
    { toolCallId: "same", toolName: "read", isError: false },
    { toolCallId: "same_1", toolName: "write", isError: false },
    { toolCallId: "same_2", toolName: "bash", isError: false },
  ]);
  expect(messages).toEqual(before);
});
