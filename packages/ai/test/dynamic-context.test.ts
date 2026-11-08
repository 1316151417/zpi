import assert from "node:assert/strict";
import { expect, it } from "vitest";
import { fakeModel } from "../../../tests/fake-server.ts";
import { streamSimple } from "../src/stream.ts";
import type { JsonObject, Message, Model } from "../src/types.ts";
import { emptyAssistant, normalizeContext } from "../src/utils/transcript.ts";
import { getModel } from "./helpers/anthropic.ts";

const models: Model[] = [
  fakeModel("http://localhost"),
  { ...fakeModel("http://localhost"), compat: { supportsDeveloperRole: true } },
  { ...fakeModel("http://localhost"), api: "openai-responses" },
  getModel(),
  { ...getModel(), compat: { supportsMidConvoSystemMessages: true } },
];
async function capture(model: Model, messages: Message[]) {
  let payload: JsonObject | undefined;
  await streamSimple(model, normalizeContext({ messages }), {
    apiKey: "local",
    onPayload(value) {
      payload = value as JsonObject;
      throw new Error("captured before network");
    },
  }).result();
  assert(payload);
  return payload;
}
// Cache breakpoints move to the tail; they do not change message content or order.
function withoutMarkers(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutMarkers);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => key !== "cache_control")
        .map(([key, part]) => [key, withoutMarkers(part)]),
    );
  return value;
}
it.each(models)("preserves ordered context updates in the final $api request ($compat)", async (model) => {
  const initial: Message[] = [
    { role: "system", content: "STABLE_BASE", timestamp: 0 },
    {
      role: "system",
      content: "",
      sections: { agents: "OLD_AGENTS", memory: "UNCHANGED_MEMORY" },
      timestamp: 1,
    },
    { role: "user", content: "FIRST_INPUT", timestamp: 2 },
  ];
  const first = await capture(model, initial);
  const reply = { ...emptyAssistant(model), content: [{ type: "text" as const, text: "FIRST_ANSWER" }] };
  const second = await capture(model, [
    ...initial,
    reply,
    { role: "system", content: "", sections: { agents: "NEW_AGENTS", memory: null }, timestamp: 3 },
    { role: "user", content: "SECOND_INPUT", timestamp: 4 },
  ]);
  const firstRows = (first.messages ?? first.input) as JsonObject[];
  const rows = (second.messages ?? second.input) as JsonObject[];
  expect(withoutMarkers(rows.slice(0, firstRows.length))).toEqual(withoutMarkers(firstRows));
  expect(second.instructions).toEqual(first.instructions);
  expect(second.system).toEqual(first.system);
  const wire = JSON.stringify(rows);
  expect(wire.indexOf("NEW_AGENTS")).toBeGreaterThan(wire.indexOf("FIRST_ANSWER"));
  expect(wire.indexOf("NEW_AGENTS")).toBeLessThan(wire.indexOf("SECOND_INPUT"));
  const update = rows.find((row) => JSON.stringify(row).includes("NEW_AGENTS"));
  assert(update);
  expect(JSON.stringify(update)).toContain("replaces all earlier versions");
  expect(JSON.stringify(update)).toContain("is withdrawn");
  expect(JSON.stringify(update)).not.toContain("UNCHANGED_MEMORY");
  expect(JSON.stringify(first.system ?? first.instructions ?? firstRows[0])).not.toContain("OLD_AGENTS");
  expect(update.role).toBe(
    model.api === "openai-responses" || model.compat?.supportsDeveloperRole
      ? "developer"
      : model.api === "anthropic-messages" && !model.compat?.supportsMidConvoSystemMessages
        ? "user"
        : "system",
  );
});

it.each(models)("keeps context updates outside tool call/result batches on $api", async (model) => {
  const call = {
    ...emptyAssistant(model),
    stopReason: "toolUse" as const,
    content: [{ type: "toolCall" as const, id: "call", name: "read", arguments: {} }],
  };
  const request = await capture(model, [
    { role: "system", content: "BASE", timestamp: 0 },
    call,
    { role: "system", content: "", sections: { note: "DEFERRED_UPDATE" }, timestamp: 1 },
    {
      role: "toolResult",
      toolCallId: "call",
      toolName: "read",
      content: [{ type: "text", text: "TOOL_OUTPUT" }],
      isError: false,
      timestamp: 2,
    },
    { role: "user", content: "AFTER_TOOLS", timestamp: 3 },
  ]);
  const wire = JSON.stringify(request.messages ?? request.input);
  expect(wire.indexOf("DEFERRED_UPDATE")).toBeGreaterThan(wire.indexOf("TOOL_OUTPUT"));
  expect(wire.indexOf("DEFERRED_UPDATE")).toBeLessThan(wire.indexOf("AFTER_TOOLS"));
});
