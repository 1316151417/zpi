import { expect, it } from "vitest";
import { streamSimple } from "../src/api/anthropic-messages.ts";
import type { JsonObject, Message } from "../src/types.ts";
import { finalizeProviderCacheControl } from "../src/utils/provider-cache.ts";
import { normalizeContext } from "../src/utils/transcript.ts";
import { getModel } from "./helpers/anthropic.ts";

it("retains independent system breakpoints and replaces all non-system markers", () => {
  const messages: Message[] = [
    { role: "system", content: "stable", timestamp: 0, cacheControl: { type: "ephemeral" } },
    { role: "system", content: "dynamic", timestamp: 0, cacheControl: { type: "ephemeral" } },
    { role: "user", content: "old", timestamp: 0, cacheControl: { type: "ephemeral" } },
    { role: "user", content: "new", timestamp: 0 },
  ];
  const original = structuredClone(messages);
  const result = finalizeProviderCacheControl(messages);
  expect(result.filter((message) => message.cacheControl)).toHaveLength(3);
  expect(result[2].cacheControl).toBeUndefined();
  expect(result[3].cacheControl).toEqual({ type: "ephemeral" });
  expect(finalizeProviderCacheControl(messages, { skipCacheWrite: true })[2].cacheControl).toEqual({
    type: "ephemeral",
  });
  expect(messages).toEqual(original);
});
it.each([false, true])(
  "maps stable/dynamic system and tail breakpoints to Anthropic (skipCacheWrite=%s)",
  async (skipCacheWrite) => {
    let payload: JsonObject = {};
    await streamSimple(
      getModel(),
      normalizeContext({
        messages: [
          { role: "system", content: "stable", sections: { dynamic: "dynamic" }, timestamp: 0 },
          { role: "user", content: "old", timestamp: 0 },
          { role: "user", content: "request-local prompt", timestamp: 0 },
        ],
      }),
      {
        apiKey: "local",
        skipCacheWrite,
        onPayload(value) {
          payload = value as JsonObject;
          throw new Error("captured");
        },
      },
    ).result();
    const systems = payload.system as JsonObject[];
    expect(systems.map((system) => system.cache_control)).toEqual([
      { type: "ephemeral" },
      { type: "ephemeral" },
    ]);
    const messages = payload.messages as JsonObject[];
    const cached = messages.filter(
      (message) =>
        Array.isArray(message.content) &&
        (message.content as JsonObject[]).some((block) => block.cache_control),
    );
    expect(cached).toHaveLength(1);
    expect((cached[0].content as JsonObject[])[0].text).toBe(skipCacheWrite ? "old" : "request-local prompt");
  },
);
