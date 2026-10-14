import { Type } from "typebox";
import { expect, it } from "vitest";
import {
  type AssistantMessage,
  createAssistantMessageEventStream,
  emptyAssistant,
  getCurrentSystemPrompt,
} from "zpi-ai";
import {
  createAgentSession,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  StaticResourceLoader,
} from "zpi-coding-agent";
import { deferred, fakeConfig, fakeModel } from "../../../tests/fake-server.ts";

it.each([
  { kind: "empty", split: false, content: [], stopReason: "stop" },
  { kind: "whitespace", split: false, content: [{ type: "text", text: " \n\t " }], stopReason: "stop" },
  {
    kind: "thinking-only",
    split: false,
    content: [{ type: "thinking", thinking: "Need to summarize" }],
    stopReason: "stop",
  },
  {
    kind: "aborted",
    split: false,
    content: [{ type: "text", text: "Incomplete checkpoint" }],
    stopReason: "aborted",
  },
  { kind: "empty split-turn", split: true, content: [], stopReason: "stop" },
  {
    kind: "aborted split-turn",
    split: true,
    content: [{ type: "text", text: "Incomplete turn prefix" }],
    stopReason: "aborted",
  },
] satisfies {
  kind: string;
  split: boolean;
  content: AssistantMessage["content"];
  stopReason: AssistantMessage["stopReason"];
}[])(
  "rejects $kind summaries without replacing the active history",
  async ({ split, content, stopReason }) => {
    const model = fakeModel("");
    const manager = SessionManager.inMemory();
    manager.appendMessage({ role: "user", content: "Keep this original requirement", timestamp: 1 });
    manager.appendMessage({
      ...emptyAssistant(model),
      content: [{ type: "text", text: "Original answer" }],
      stopReason: "stop",
    });
    manager.appendMessage({ role: "user", content: "Keep this recent requirement", timestamp: 2 });
    if (split)
      manager.appendMessage({
        ...emptyAssistant(model),
        content: [{ type: "text", text: "Recent answer" }],
        stopReason: "stop",
      });
    let calls = 0;
    const runtime = await ModelRuntime.create();
    runtime.registerProvider("fake", {
      models: [fakeConfig("")],
      streamSimple(model) {
        calls++;
        const stream = createAssistantMessageEventStream();
        const badSummary = !split || calls === 2;
        stream.end({
          ...emptyAssistant(model),
          content: badSummary ? content : [{ type: "text", text: "Valid history checkpoint" }],
          stopReason: badSummary ? stopReason : "stop",
        });
        return stream;
      },
    });
    const { session } = await createAgentSession({
      modelRuntime: runtime,
      sessionManager: manager,
      settingsManager: SettingsManager.inMemory({
        compaction: { enabled: false, keepRecentTokens: 1 },
        retry: { enabled: false },
      }),
      resourceLoader: new StaticResourceLoader(),
      noTools: "all",
    });
    try {
      const before = session.messages.slice();
      await expect(session.compact()).rejects.toThrow(/empty summary|aborted/);
      expect(calls).toBe(split ? 2 : 1);
      expect(manager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(0);
      expect(session.messages).toEqual(before);
      expect(manager.buildSessionContext().messages).toEqual(before);
      expect(session.isIdle).toBe(true);
    } finally {
      session.dispose();
    }
  },
);

it("uses transcript order for compaction when new replies have older timestamps", async () => {
  const runtime = await ModelRuntime.create();
  let turns = 0;
  runtime.registerProvider("fake", {
    models: [{ ...fakeConfig(""), contextWindow: 10000 }],
    streamSimple(model, context) {
      const summary = getCurrentSystemPrompt(context.messages).startsWith(
        "You are a context summarization assistant.",
      );
      const output = emptyAssistant(model);
      if (summary) output.content = [{ type: "text", text: "Completed tool turns" }];
      else {
        turns++;
        // Provider timestamps may be equal or move backwards; only transcript order defines the boundary.
        output.timestamp = 1;
        output.usage.input = output.usage.totalTokens = 100;
        output.content =
          turns <= 3
            ? [{ type: "toolCall", id: `large${turns}`, name: "large", arguments: {} }]
            : [{ type: "text", text: "done" }];
        output.stopReason = turns <= 3 ? "toolUse" : "stop";
      }
      const stream = createAssistantMessageEventStream();
      stream.end(output);
      return stream;
    },
  });
  const manager = SessionManager.inMemory();
  const { session } = await createAgentSession({
    modelRuntime: runtime,
    sessionManager: manager,
    settingsManager: SettingsManager.inMemory({
      compaction: { reserveTokens: 7000, keepRecentTokens: 10 },
      retry: { enabled: false },
    }),
    resourceLoader: new StaticResourceLoader(),
    noTools: "builtin",
    customTools: [
      {
        name: "large",
        label: "Large result",
        description: "Return a large local test result",
        parameters: Type.Object({}),
        execute: async () => ({ content: [{ type: "text", text: "x".repeat(20000) }], details: undefined }),
      },
    ],
  });
  try {
    await session.prompt("Collect three large results then answer");
    expect(turns).toBe(4);
    expect(manager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(3);
    expect(session.messages).toEqual(manager.buildSessionContext().messages);
  } finally {
    session.dispose();
  }
});

it("declines steering during manual compaction instead of leaking it into the next prompt", async () => {
  const started = deferred();
  const release = deferred();
  const contexts: string[] = [];
  const runtime = await ModelRuntime.create();
  runtime.registerProvider("fake", {
    models: [fakeConfig("")],
    streamSimple(model, context) {
      const stream = createAssistantMessageEventStream();
      const output = {
        ...emptyAssistant(model),
        content: [{ type: "text" as const, text: "Complete summary or answer" }],
      };
      if (getCurrentSystemPrompt(context.messages).startsWith("You are a context summarization assistant.")) {
        started.resolve();
        void release.promise.then(() => stream.end(output));
      } else {
        contexts.push(JSON.stringify(context));
        stream.end(output);
      }
      return stream;
    },
  });
  const manager = SessionManager.inMemory();
  manager.appendMessage({ role: "user", content: "Original requirement", timestamp: 1 });
  manager.appendMessage({
    ...emptyAssistant(fakeModel("")),
    content: [{ type: "text", text: "Original answer" }],
  });
  manager.appendMessage({ role: "user", content: "Recent requirement", timestamp: 2 });
  const { session } = await createAgentSession({
    modelRuntime: runtime,
    sessionManager: manager,
    settingsManager: SettingsManager.inMemory({ compaction: { enabled: false, keepRecentTokens: 1 } }),
    resourceLoader: new StaticResourceLoader(),
    noTools: "all",
  });
  try {
    const compacting = session.compact();
    await started.promise;
    const accepted = session.steer("Stale guidance during manual compaction");
    release.resolve();
    await compacting;
    const prompting = session.prompt("Next task");
    expect(session.steer("Current prompt guidance")).toBe(true);
    await prompting;
    expect(accepted).toBe(false);
    expect(contexts).toHaveLength(2);
    expect(contexts[1]).toContain("Current prompt guidance");
    expect(contexts.join()).not.toContain("Stale guidance during manual compaction");
  } finally {
    release.resolve();
    session.dispose();
  }
});
