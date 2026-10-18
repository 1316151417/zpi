import { expect, it } from "vitest";
import { streamSimple } from "../src/api/anthropic-messages.ts";
import type { JsonObject, Message } from "../src/types.ts";
import {
  assertProviderCacheControlLimit,
  finalizeProviderCacheControl,
} from "../src/utils/provider-cache.ts";
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

it.each([false, true])(
  "keeps the entire Anthropic payload within four cache breakpoints (OAuth=%s)",
  async (oauth) => {
    let payload: JsonObject = {};
    await streamSimple(
      getModel(),
      normalizeContext({
        messages: [
          {
            role: "system",
            content: "stable",
            sections: { dynamic: "dynamic" },
            timestamp: 0,
            toolsAdded: [
              { name: "read", description: "Read", parameters: { type: "object", properties: {} } },
            ],
          },
          { role: "user", content: "hello", timestamp: 1 },
        ],
      }),
      {
        apiKey: oauth ? "sk-ant-oat01-local-test" : "local",
        onPayload(value) {
          payload = value as JsonObject;
          throw new Error("captured");
        },
      },
    ).result();
    const count = (value: unknown): number =>
      !value || typeof value !== "object"
        ? 0
        : Object.entries(value).reduce(
            (n, [key, item]) => n + (key === "cache_control" ? 1 : count(item)),
            0,
          );
    expect(count(payload)).toBe(4);
  },
);

it("rejects excessive cache markers before a request while ignoring cache_control in tool arguments", () => {
  const marker = { cache_control: { type: "ephemeral" } };
  expect(() =>
    assertProviderCacheControlLimit({
      system: [marker, marker],
      tools: [marker],
      messages: [{ content: [marker] }],
    }),
  ).not.toThrow();
  expect(() =>
    assertProviderCacheControlLimit({
      system: [marker, marker],
      tools: [marker],
      messages: [{ content: [marker, marker] }],
    }),
  ).toThrow("at most 4");
  expect(() =>
    assertProviderCacheControlLimit({
      messages: [{ content: [{ type: "tool_use", input: { cache_control: "user data" } }] }],
    }),
  ).not.toThrow();
});

it("preserves line separators in array system content while retaining separate section breakpoints", async () => {
  let payload: JsonObject = {};
  await streamSimple(
    getModel(),
    normalizeContext({
      messages: [
        {
          role: "system",
          content: [
            { type: "text", text: "first" },
            { type: "text", text: "second" },
          ],
          sections: { dynamic: "dynamic" },
          timestamp: 0,
        },
        { role: "user", content: "hello", timestamp: 1 },
      ],
    }),
    {
      apiKey: "local",
      onPayload(value) {
        payload = value as JsonObject;
        throw new Error("captured");
      },
    },
  ).result();
  expect((payload.system as JsonObject[]).map((block) => block.text)).toEqual(["first\nsecond", "dynamic"]);
});
