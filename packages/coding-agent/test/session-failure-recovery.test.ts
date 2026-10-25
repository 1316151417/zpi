import { join } from "node:path";
import { expect, it, vi } from "vitest";
import type { Message, Model } from "zpi-ai";
import { createAssistantMessageEventStream, emptyAssistant } from "zpi-ai";
import {
  createAgentSession,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  StaticResourceLoader,
} from "zpi-coding-agent";
import { fakeConfig, fakeModel } from "../../../tests/fake-server.ts";
import { generateSummaryWithUsage } from "../src/core/compaction.ts";
import { directory } from "./helpers/session-fixture.ts";

async function fixture(manager = SessionManager.inMemory()) {
  const runtime = new ModelRuntime();
  const stream = vi.fn((model: Model) => {
    const output = createAssistantMessageEventStream();
    output.end({ ...emptyAssistant(model), content: [{ type: "text", text: "answer" }] });
    return output;
  });
  runtime.registerProvider("fake", {
    models: [{ ...fakeConfig(""), reasoning: true, compat: { supportsReasoningEffort: true } }],
    streamSimple: stream,
  });
  const loader = Object.assign(new StaticResourceLoader(), { reload: vi.fn(async () => {}) });
  const { session } = await createAgentSession({
    modelRuntime: runtime,
    sessionManager: manager,
    settingsManager: SettingsManager.inMemory({
      compaction: { enabled: false, keepRecentTokens: 1 },
      retry: { enabled: false },
    }),
    resourceLoader: loader,
    noTools: "all",
    thinkingLevel: "high",
  });
  return { session, manager, loader, stream };
}

it.each(["prompt", "compact"] as const)(
  "clears a rejected %s run before idle and abort are called",
  async (method) => {
    const f = await fixture();
    if (method === "compact") await f.session.prompt("initial requirement ".repeat(50));
    const reload = vi.spyOn(f.loader, "reload").mockRejectedValueOnce(new Error("reload failed"));
    try {
      await expect(method === "prompt" ? f.session.prompt("first") : f.session.compact()).rejects.toThrow(
        "reload failed",
      );
      expect(f.session.isIdle).toBe(true);
      await expect(f.session.waitForIdle()).resolves.toBeUndefined();
      await expect(f.session.abort()).resolves.toBeUndefined();
      await f.session.prompt("retry");
      expect(f.session.messages.at(-1)).toMatchObject({ content: [{ text: "answer" }] });
    } finally {
      reload.mockRestore();
      f.session.dispose();
    }
  },
);

it("clamps and persists thinking when switching to a model without reasoning", async () => {
  const f = await fixture();
  try {
    expect(f.session.thinkingLevel).toBe("high");
    await f.session.setModel({
      ...f.session.model,
      id: "no-reasoning",
      reasoning: false,
      reasoningConfig: undefined,
    });
    expect(f.session.thinkingLevel).toBe("off");
    expect(f.manager.getCurrentState().thinkingLevel).toBe("off");
  } finally {
    f.session.dispose();
  }
});

it("opens and durably repairs an orphan before a later assistant reuses its call ID", async () => {
  const cwd = await directory();
  const manager = SessionManager.create(cwd, join(cwd, "sessions"));
  const assistant = emptyAssistant(fakeModel(""));
  manager.appendMessage({ role: "user", content: "old request", timestamp: 0 });
  for (const name of ["read", "write"])
    manager.appendMessage({
      ...assistant,
      content: [{ type: "toolCall", id: "same", name, arguments: {} }],
      stopReason: "toolUse",
    });
  manager.appendMessage({
    role: "toolResult",
    toolCallId: "same",
    toolName: "write",
    content: [{ type: "text", text: "committed" }],
    isError: false,
    timestamp: 1,
  });
  manager.appendMessage({ ...assistant, content: [{ type: "text", text: "later answer" }] });
  const f = await fixture(manager);
  try {
    const messages = f.session.messages.filter((message) => message.role !== "system");
    expect(messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "toolResult",
      "assistant",
      "toolResult",
      "assistant",
    ]);
    expect(messages[2]).toMatchObject({
      toolName: "read",
      isError: true,
      content: [{ text: expect.stringContaining("not re-executed") }],
    });
    expect(messages[4]).toMatchObject({ toolName: "write", isError: false });
    expect(SessionManager.open(manager.getSessionFile() as string).buildSessionContext().messages).toEqual(
      f.session.messages,
    );
    const before = f.manager.getEntries();
    const second = await fixture(manager);
    second.session.dispose();
    expect(f.manager.getEntries()).toEqual(before);
    expect(f.stream).not.toHaveBeenCalled();
    await f.session.prompt("continue");
    expect(f.stream).toHaveBeenCalledTimes(1);
  } finally {
    f.session.dispose();
  }
});

it.each([0, 1])(
  "gives summary requests a positive output budget with reserveTokens=%s",
  async (reserveTokens) => {
    let maxTokens: number | undefined;
    const model = fakeModel("");
    const messages: Message[] = [{ role: "user", content: "summarize", timestamp: 0 }];
    await generateSummaryWithUsage(
      messages,
      model,
      reserveTokens,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      (selected, _context, options) => {
        maxTokens = options?.maxTokens;
        const output = createAssistantMessageEventStream();
        output.end({ ...emptyAssistant(selected), content: [{ type: "text", text: "summary" }] });
        return output;
      },
    );
    expect(maxTokens).toBeGreaterThan(0);
    expect(maxTokens).toBeLessThanOrEqual(model.maxTokens);
  },
);

it.each(["self", "later"])("rejects a compaction boundary pointing to %s entries", async (kind) => {
  const { buildSessionContext } = await import("../src/core/session-manager.ts");
  const manager = SessionManager.inMemory();
  const kept = manager.appendMessage({ role: "user", content: "kept", timestamp: 0 });
  manager.appendCompaction("summary", kept);
  manager.appendMessage({ role: "user", content: "later", timestamp: 1 });
  const entries = manager.getEntries();
  const compaction = entries[1];
  if (compaction.type !== "compaction") throw new Error("Expected compaction");
  compaction.firstKeptEntryId = entries[kind === "self" ? 1 : 2].id;
  expect(() => buildSessionContext(entries)).toThrow("Invalid compaction boundary");
});
