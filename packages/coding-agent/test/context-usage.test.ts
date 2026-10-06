import { emptyAssistant } from "ZPI-ai";
import { contextUsage, SessionManager } from "ZPI-coding-agent";
import { expect, it } from "vitest";
import { fakeModel } from "../../../tests/fake-server.ts";

it("retains the last measured context across models and missing usage, updates on valid usage and clears on compaction", () => {
  const model = fakeModel("");
  const other = { ...model, id: "other", provider: "other", contextWindow: 10000 };
  const manager = SessionManager.inMemory();
  const reply = emptyAssistant(model);
  reply.stopReason = "stop";
  reply.usageAvailable = reply.cacheUsageAvailable = true;
  reply.usage.input = 500;
  reply.usage.cacheRead = 1500;
  reply.usage.totalTokens = 2008;
  reply.contextBreakdown = [{ source: "messages", chars: 80 }];
  manager.appendMessage(reply);
  manager.appendModelChange(other.provider, other.id);
  const missing = emptyAssistant(other);
  missing.stopReason = "stop";
  missing.usageAvailable = false;
  manager.appendMessage(missing);
  expect(contextUsage(manager.getEntries(), other)).toMatchObject({
    inputTokens: 2000,
    contextWindow: 10000,
    percent: 20,
    breakdown: reply.contextBreakdown,
  });
  const next = {
    ...reply,
    model: other.id,
    provider: other.provider,
    usage: { ...reply.usage, input: 1500 },
  };
  const id = manager.appendMessage(next);
  expect(contextUsage(manager.getEntries(), other).inputTokens).toBe(3000);
  manager.appendCompaction("summary", id);
  expect(contextUsage(manager.getEntries(), other).inputTokens).toBeNull();
});
