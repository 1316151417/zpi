import { expect, it } from "vitest";
import { emptyAssistant, type Message, type ToolResultMessage } from "zpi-ai";
import { SessionManager, SettingsManager } from "zpi-coding-agent";
import { fakeModel } from "../../../tests/fake-server.ts";
import { buildDefaultMicrocompactThreshold, maybeMicrocompact } from "../src/core/microcompact.ts";

function groups(size = 1600): Message[] {
  return Array.from({ length: 7 }, (_, i): Message[] => [
    {
      ...emptyAssistant(fakeModel("http://unused")),
      content: [{ type: "toolCall", id: String(i), name: "read", arguments: {} }],
      stopReason: "toolUse",
    },
    {
      role: "toolResult",
      toolCallId: String(i),
      toolName: "read",
      content: [{ type: "text", text: "x".repeat(size) }],
      isError: false,
      timestamp: i,
    },
  ]).flat();
}
it("defaults off; idle > 60 minutes and token pressure independently trigger when enabled", () => {
  const messages = groups();
  expect(SettingsManager.inMemory().getMicrocompactSettings().enabled).toBe(false);
  expect(
    maybeMicrocompact({ messages, lastAssistantCompletedAtMs: 0, nowMs: 61 * 60_000 }).boundary,
  ).toBeUndefined();
  const config = { enabled: true, thresholdTokens: 999_999 };
  expect(
    maybeMicrocompact({ messages, config, lastAssistantCompletedAtMs: 0, nowMs: 60 * 60_000 }).boundary,
  ).toBeUndefined();
  const result = maybeMicrocompact({
    messages,
    config,
    lastAssistantCompletedAtMs: 0,
    nowMs: 60 * 60_000 + 1,
  });
  expect(result.boundary).toMatchObject({
    trigger: "time_based",
    clearedToolCallIds: ["0", "1"],
    keptToolCallIds: ["2", "3", "4", "5", "6"],
  });
  expect(
    maybeMicrocompact({ messages, config: { enabled: true, thresholdTokens: 1 } }).boundary?.trigger,
  ).toBe("token_pressure");
  expect(buildDefaultMicrocompactThreshold(100_000)).toBe(90_000);
  expect(buildDefaultMicrocompactThreshold(10_000)).toBe(8000);
});
it("never clears image, video or file tool results, including files with extracted text", () => {
  for (const type of ["image", "video", "file"]) {
    const messages = groups();
    const media = {
      ...messages[1],
      content: [
        {
          type,
          data: "base64",
          dataUrl: "data:media;base64,a",
          mimeType: "image/png",
          text: "extracted text",
        },
      ],
    } as unknown as ToolResultMessage;
    messages[1] = media;
    const result = maybeMicrocompact({
      messages,
      config: { enabled: true, thresholdTokens: 1, keepRecentToolResults: 1 },
    });
    expect(result.boundary?.clearedToolCallIds).not.toContain("0");
    expect(result.messages[1]).toBe(media);
  }
});
it("rolls back the whole projection below 256 saved tokens; errors and unknown tools are skipped", () => {
  const messages = groups(40);
  expect(maybeMicrocompact({ messages, config: { enabled: true, thresholdTokens: 1 } }).messages).toBe(
    messages,
  );
  const larger = groups();
  (larger[1] as ToolResultMessage).isError = true;
  (larger[3] as ToolResultMessage).toolName = "custom";
  const result = maybeMicrocompact({
    messages: larger,
    config: { enabled: true, thresholdTokens: 1, keepRecentToolResults: 1 },
  });
  expect(result.boundary?.clearedToolCallIds).not.toContain("0");
  expect(result.boundary?.clearedToolCallIds).not.toContain("1");
  expect(result.messages[1]).toBe(larger[1]);
});
it("clears whole assistant tool-call groups and records a replayable boundary without changing originals", () => {
  const messages = groups();
  const parallel: ToolResultMessage = { ...(messages[1] as ToolResultMessage), toolCallId: "parallel" };
  messages.splice(2, 0, parallel);
  const original = structuredClone(messages);
  const result = maybeMicrocompact({ messages, config: { enabled: true, thresholdTokens: 1 } });
  expect(result.boundary?.clearedToolCallIds).toEqual(["0", "parallel", "1"]);
  expect(result.boundary?.preMicrocompactTokenCount).toBeGreaterThan(
    result.boundary?.postMicrocompactTokenCount ?? 0,
  );
  expect(result.messages[1].content).toEqual([{ type: "text", text: "[Old tool result content cleared]" }]);
  expect(messages).toEqual(original);
  const manager = SessionManager.inMemory();
  for (const message of messages) manager.appendMessage(message);
  if (!result.boundary) throw new Error("Expected microcompact boundary");
  manager.appendMicrocompact(result.boundary);
  expect(manager.buildSessionContext().messages).toEqual(result.messages);
  expect(
    manager
      .getEntries()
      .filter((e) => e.type === "message")
      .map((e) => (e.type === "message" ? e.message : null)),
  ).toEqual(original);
});

it("counts system text in token-pressure decisions", () => {
  const messages = groups();
  const config = { enabled: true, thresholdTokens: 5000 };
  expect(maybeMicrocompact({ messages, config }).boundary).toBeUndefined();
  const result = maybeMicrocompact({
    messages: [{ role: "system", content: "s".repeat(20_000), timestamp: 0 }, ...messages],
    config,
  });
  expect(result.boundary?.trigger).toBe("token_pressure");
});
