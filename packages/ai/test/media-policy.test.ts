import { expect, it, vi } from "vitest";
import {
  emptyAssistant,
  normalizeContext,
  projectContextForModelMediaPolicy,
  projectMessagesForMediaBudget,
  streamSimple,
} from "zpi-ai";
import { fakeModel } from "../../../tests/fake-server.ts";
import { isModelContextExceededMessage, isModelMediaTooLargeMessage } from "../src/utils/overflow.ts";

type Block = { type: string; dataUrl?: string; text?: string; mediaType?: string; name?: string };
const image = (bytes: number, name = "image"): Block => ({
  type: "image",
  mediaType: "image/png",
  name,
  dataUrl: "x".repeat(bytes),
});
const message = (content: Block[], role = "toolResult") => ({ role, content });
const retainedNames = (messages: ReturnType<typeof message>[]) =>
  messages.flatMap((m) => m.content.filter((b) => b.type === "image").map((b) => b.name));

it("returns the same message array and objects below budget", () => {
  const messages = [message([image(30)])];
  expect(projectMessagesForMediaBudget(messages, { maxMediaBytes: 30 }).messages).toBe(messages);
  expect(projectMessagesForMediaBudget(messages, { maxMediaBytes: 30 }).evictionFrontier).toBeNull();
});
it("protects only the latest real user and counts data URL UTF-8 bytes, including prefixes", () => {
  const messages = [
    message([image(8, "old")], "user"),
    message([image(2, "current")], "user"),
    { ...message([image(6, "synthetic")], "user"), synthetic: true },
    message([image(3, "tool")]),
  ];
  const original = structuredClone(messages);
  const result = projectMessagesForMediaBudget(messages, { maxMediaBytes: 10 });
  expect(retainedNames(result.messages)).toEqual(["current", "tool"]);
  expect(result).toMatchObject({
    omittedMediaCount: 2,
    retainedMediaCount: 2,
    projectedMediaBytes: 5,
    totalMediaBytes: 19,
    evictionFrontier: { messageIndex: 2, blockIndex: 0 },
  });
  expect(result.messages[0].content[0]).toEqual({
    type: "text",
    text: "[Attached image/png: old]\n[Media omitted from provider request to keep the request body under the configured media budget.]",
  });
  expect(messages).toEqual(original);
  const mixed = [
    message([
      { type: "image", dataUrl: "data:image/png;base64,é" },
      { type: "video", dataUrl: "abc" },
      { type: "file", dataUrl: "abcd" },
      { type: "file", dataUrl: "large uncounted", text: "extracted text" },
      { type: "text", text: "not counted" },
    ]),
  ];
  expect(projectMessagesForMediaBudget(mixed).totalMediaBytes).toBe(
    Buffer.byteLength("data:image/png;base64,é") + 7,
  );
});
it("may evict even the newest tool image and preserves the unnamed placeholder byte for byte", () => {
  const result = projectMessagesForMediaBudget(
    [message([{ type: "image", mediaType: "image/png", dataUrl: "x" }])],
    { maxMediaBytes: 0 },
  );
  expect(result.messages[0].content[0]).toEqual({
    type: "text",
    text: "[Attached image/png]\n[Media omitted from provider request to keep the request body under the configured media budget.]",
  });
});
it("retains a continuous newest suffix for randomized mixed sizes and block indexes", () => {
  let seed = 17;
  const random = () => (seed = (seed * 1664525 + 1013904223) >>> 0);
  for (let run = 0; run < 300; run++) {
    const messages = Array.from({ length: 2 + (random() % 20) }, (_, i) =>
      message([image(1 + (random() % 20), `${i}a`), image(1 + (random() % 20), `${i}b`)]),
    );
    const result = projectMessagesForMediaBudget(messages, { maxMediaBytes: random() % 200 });
    const states = result.messages.flatMap((m) => m.content.map((b) => b.type === "image"));
    const firstRetained = states.indexOf(true);
    if (firstRetained >= 0) expect(states.slice(firstRetained)).not.toContain(false);
    expect(result.projectedMediaBytes).toBeLessThanOrEqual(199);
  }
});
it("does not revive A behind B when D is appended (chronological A=2 B=6 C=4 D=4)", () => {
  const messages = [message([image(2, "A")]), message([image(6, "B")]), message([image(4, "C")])];
  expect(retainedNames(projectMessagesForMediaBudget(messages, { maxMediaBytes: 10 }).messages)).toEqual([
    "B",
    "C",
  ]);
  expect(
    retainedNames(
      projectMessagesForMediaBudget([...messages, message([image(4, "D")])], { maxMediaBytes: 10 }).messages,
    ),
  ).toEqual(["C", "D"]);
});
it("rejects oversized current media before a provider is called; capability projection runs first", async () => {
  const model = { ...fakeModel("http://unused"), input: ["text", "image"] as ("text" | "image")[] };
  const context = normalizeContext({
    messages: [
      {
        role: "user",
        timestamp: 0,
        content: [{ type: "image", mimeType: "image/png", data: "a".repeat(40 * 1024 * 1024) }],
      },
    ],
  });
  const fetch = vi.fn();
  const result = await streamSimple(model, context, { apiKey: "local", fetch }).result();
  expect(fetch).not.toHaveBeenCalled();
  expect(result.errorMessage).toContain("MEDIA_BUDGET_CURRENT_ATTACHMENT_TOO_LARGE");
  expect(result.errorDetails?.retryable).toBe(false);
  const textOnly = projectContextForModelMediaPolicy(context, { input: ["text"] }, { maxMediaBytes: 0 });
  expect(textOnly.messages[0].content).toEqual([{ type: "text", text: "[Attached image/png]" }]);
  expect(() =>
    projectMessagesForMediaBudget([message([image(11)], "user")], { maxMediaBytes: 10 }),
  ).toThrowError(
    expect.objectContaining({
      code: "MEDIA_BUDGET_CURRENT_ATTACHMENT_TOO_LARGE",
      type: "InvalidInput",
      recoverable: true,
    }),
  );
});
it("uses the exact ZCode error predicates without silently widening bare 413", () => {
  const bare = "413 Failed to buffer the request body: length limit exceeded";
  expect(isModelContextExceededMessage(bare)).toBe(false);
  expect(isModelMediaTooLargeMessage(bare)).toBe(false);
  expect(isModelContextExceededMessage("context length exceeded")).toBe(true);
  expect(isModelContextExceededMessage("prompt is too long")).toBe(true);
  expect(isModelMediaTooLargeMessage("image payload too large")).toBe(true);
  expect(isModelMediaTooLargeMessage("document exceeds limit")).toBe(true);
  expect(isModelMediaTooLargeMessage("payload too large")).toBe(false);
  expect(emptyAssistant(fakeModel("http://unused")).stopReason).toBe("stop");
});
