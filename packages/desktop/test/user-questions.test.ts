import { expect, it, vi } from "vitest";
import { chunk, done, send } from "../../../tests/fake-server.ts";
import { projectEvent } from "../src/main/projection.ts";
import { SessionHost } from "../src/main/session-host.ts";
import { UserQuestions } from "../src/main/user-questions.ts";
import { cleanup, fixture } from "./helpers/host-fixture.ts";

const params = {
  questions: [
    {
      header: "方案",
      question: "使用哪种方案？",
      multiSelect: false,
      options: [
        { label: "A", description: "第一种" },
        { label: "B", description: "第二种" },
      ],
    },
  ],
};

it.each(["__proto__", "constructor", "toString"])(
  "preserves answers keyed by %s as plain data",
  async (question) => {
    const broker = new UserQuestions(() => {});
    const execute = broker.tool("s").execute as unknown as (
      ...args: unknown[]
    ) => Promise<{ details: { answers: Record<string, string> } }>;
    const pending = execute("q", { questions: [{ ...params.questions[0], question }] }, undefined);
    broker.respond("s", "q", { answers: Object.fromEntries([[question, "A"]]) });
    const { details } = await pending;
    expect(Object.hasOwn(details.answers, question)).toBe(true);
    expect(details.answers[question]).toBe("A");
    const event = projectEvent(
      {
        type: "tool_execution_end",
        toolCallId: "q",
        toolName: "AskUserQuestion",
        result: { content: [{ type: "text", text: "plain result" }], details },
        isError: false,
      },
      "m",
    );
    expect(event?.type).toBe("tool_end");
    if (event?.type === "tool_end") {
      expect(Object.hasOwn(event.questionAnswers?.answers ?? {}, question)).toBe(true);
      expect(event.questionAnswers?.answers[question]).toBe("A");
    }
  },
);

it("projects bounded question answers without forwarding malformed values or arbitrary tool details", () => {
  const event = projectEvent(
    {
      type: "tool_execution_end",
      toolCallId: "q",
      toolName: "AskUserQuestion",
      result: {
        content: [{ type: "text", text: "result" }],
        details: {
          answers: { good: "A", bad: { toString: 1 }, long: "x".repeat(16001) },
          arbitrary: "private",
        },
      },
      isError: false,
    },
    "m",
  );
  expect(event).toMatchObject({ questionAnswers: { answers: { good: "A" } } });
  expect(JSON.stringify(event)).not.toContain("private");
});

it("waits for an explicit answer, rejects stale replies, and returns skipped questions without inventing a preference", async () => {
  const changes: unknown[] = [];
  const broker = new UserQuestions((_, request) => changes.push(request));
  const tool = broker.tool("s");
  const execute = tool.execute as (...args: unknown[]) => Promise<{ content: { text: string }[] }>;
  const pending = execute("q", params, undefined);
  expect(broker.get("s")?.id).toBe("q");
  expect(() => broker.respond("s", "old", { answers: {} })).toThrow("提问已结束");
  expect(() => broker.respond("s", "q", { answers: { unknown: "A" } })).toThrow("无效回答");
  broker.respond("s", "q", { answers: {} });
  expect((await pending).content[0].text).toContain("did not provide answers");
  expect(broker.get("s")).toBeNull();
  expect(changes).toHaveLength(2);
});

it("cancels a pending question when the run is stopped", async () => {
  const broker = new UserQuestions(() => {});
  const controller = new AbortController();
  const execute = broker.tool("s").execute as (...args: unknown[]) => Promise<unknown>;
  const pending = execute("q", params, controller.signal);
  controller.abort();
  await expect(pending).rejects.toThrow("cancelled");
  expect(broker.get("s")).toBeNull();
});

it("shows authoritative countdown state after a minute and continues unanswered questions at five minutes", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  try {
    const broker = new UserQuestions(() => {});
    const execute = broker.tool("s").execute as (
      ...args: unknown[]
    ) => Promise<{ content: { text: string }[] }>;
    const pending = execute("q", params, undefined);
    expect(broker.get("s")?.autoResolution).toEqual({
      phase: "hiddenGrace",
      startedAt: 0,
      visibleAt: 60_000,
      deadlineAt: 300_000,
    });
    await vi.advanceTimersByTimeAsync(59_000);
    expect(broker.get("s")?.autoResolution?.phase).toBe("hiddenGrace");
    await vi.advanceTimersByTimeAsync(1000);
    expect(broker.get("s")?.autoResolution?.phase).toBe("visibleCountdown");
    await vi.advanceTimersByTimeAsync(120_000);
    expect(broker.get("s")?.autoResolution?.phase).toBe("visibleCountdown");
    await vi.advanceTimersByTimeAsync(120_000);
    expect((await pending).content[0].text).toContain("within five minutes");
    expect(broker.get("s")).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});

it.each([0, 60_000])("permanently stops question timing after user interaction at %d ms", async (delay) => {
  vi.useFakeTimers();
  try {
    const broker = new UserQuestions(() => {});
    const execute = broker.tool("s").execute as (...args: unknown[]) => Promise<unknown>;
    const pending = execute("q", params, undefined);
    await vi.advanceTimersByTimeAsync(delay);
    broker.snooze("s", "old");
    expect(broker.get("s")?.autoResolution?.phase).not.toBe("snoozed");
    broker.snooze("s", "q");
    broker.snooze("s", "q");
    expect(broker.get("s")?.autoResolution?.phase).toBe("snoozed");
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(300_000);
    expect(broker.get("s")?.id).toBe("q");
    broker.respond("s", "q", { answers: {} });
    await pending;
  } finally {
    vi.useRealTimers();
  }
});

it("disabling timing stops existing questions and re-enabling applies only to future questions", async () => {
  vi.useFakeTimers();
  try {
    const broker = new UserQuestions(() => {});
    const execute = (id: string) =>
      (broker.tool(id).execute as (...args: unknown[]) => Promise<unknown>)("q", params, undefined);
    const first = execute("first");
    broker.setAutoResolutionEnabled(false);
    expect(broker.get("first")?.autoResolution?.phase).toBe("snoozed");
    const second = execute("second");
    expect(broker.get("second")?.autoResolution).toBeUndefined();
    broker.setAutoResolutionEnabled(true);
    const third = execute("third");
    await vi.advanceTimersByTimeAsync(300_000);
    await third;
    expect(broker.get("first")).not.toBeNull();
    expect(broker.get("second")).not.toBeNull();
    broker.respond("first", "q", { answers: {} });
    broker.respond("second", "q", { answers: {} });
    await Promise.all([first, second]);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});

it("snapshots the plugin for new sessions, resumes with answers, and restores the choice after restart", async () => {
  const f = await fixture((_, response, index) => {
    if (index === 0) {
      send(
        response,
        chunk({
          tool_calls: [
            {
              index: 0,
              id: "ask",
              type: "function",
              function: { name: "AskUserQuestion", arguments: JSON.stringify(params) },
            },
          ],
        }),
      );
      done(response, "tool_calls");
    } else {
      send(response, chunk({ content: "done" }));
      done(response);
    }
  });
  f.settings.setCapabilityEnabled("askUserQuestion", true);
  const session = f.host.createSession(f.a.id);
  await f.host.startRun({ sessionId: session.id, text: "choose" });
  const running = f.host.activeRuns.get(session.id)?.done;
  await expect.poll(() => f.host.getSessionSnapshot(session.id).view.question?.id).toBe("ask");
  f.settings.setCapabilityEnabled("askUserQuestion", false);
  f.host.questions.respond(session.id, "ask", { answers: { "使用哪种方案？": "B" } });
  await running;
  expect(JSON.stringify(f.server.requests[1].messages)).toContain("B");
  expect(f.host.getSessionSnapshot(session.id).view.question).toBeNull();
  const questionBlock = () =>
    f.host
      .getSessionSnapshot(session.id)
      .view.runs[0].orderedBlocks.find((block) => block.type === "tool" && block.name === "AskUserQuestion");
  expect(questionBlock()).toMatchObject({ questionAnswers: { answers: { "使用哪种方案？": "B" } } });
  const next = f.host.createSession(f.a.id);
  await f.host.startRun({ sessionId: next.id, text: "new" });
  await f.host.activeRuns.get(next.id)?.done;
  expect(JSON.stringify(f.server.requests.at(-1)?.tools)).not.toContain("AskUserQuestion");
  await f.host.close();
  const restored = new SessionHost(f.dir, f.settings, f.dir, undefined, undefined);
  await restored.init();
  cleanup.push(() => restored.close());
  expect(restored.getSessionSnapshot(session.id).view.runs[0].orderedBlocks).toContainEqual(
    expect.objectContaining({ questionAnswers: { answers: { "使用哪种方案？": "B" } } }),
  );
  await restored.startRun({ sessionId: session.id, text: "continue" });
  await restored.activeRuns.get(session.id)?.done;
  expect(JSON.stringify(f.server.requests.at(-1)?.tools)).toContain("AskUserQuestion");
});
