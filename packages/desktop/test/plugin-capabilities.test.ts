import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { SessionHost } from "../src/main/session-host.ts";
import { SettingsStore } from "../src/main/storage.ts";
import { cleanup, codec, fixture, run } from "./helpers/context-fixture.ts";

test.each(
  [
    [true, true, true, true],
    [true, true, true, false],
    [true, true, false, true],
    [true, true, false, false],
    [true, false, true, true],
    [true, false, true, false],
    [true, false, false, true],
    [true, false, false, false],
    [false, true, true, true],
    [false, true, true, false],
    [false, true, false, true],
    [false, true, false, false],
    [false, false, true, true],
    [false, false, true, false],
    [false, false, false, true],
    [false, false, false, false],
  ].flatMap((switches) => [true, false].map((communicationStyle) => [communicationStyle, ...switches])),
)(
  "plugin prompt rules follow independent switches: communication=%s, batching=%s, links=%s, reuse=%s, proactive=%s",
  async (communicationStyle, toolBatching, fileLinks, fileContextReuse, proactiveExecution) => {
    const f = await fixture();
    f.settings.setCapabilityEnabled("subagents", false);
    const basePrompt = (await f.host.previewPrompt()).basePrompt;
    f.settings.setCapabilityEnabled("communicationStyle", communicationStyle);
    f.settings.setCapabilityEnabled("toolBatching", toolBatching);
    f.settings.setCapabilityEnabled("fileLinks", fileLinks);
    f.settings.setCapabilityEnabled("fileContextReuse", fileContextReuse);
    f.settings.setCapabilityEnabled("proactiveExecution", proactiveExecution);
    const preview = await f.host.previewPrompt();
    for (const rule of [
      "Before the first tool call",
      "all answers, conclusions, and deliverables",
      "use clear, complete sentences",
      "answer simple questions directly in prose",
      "add comments only for constraints the code cannot express",
    ]) {
      expect(preview.systemRules.includes(rule)).toBe(communicationStyle);
      expect(preview.basePrompt).not.toContain(rule);
    }
    if (communicationStyle && toolBatching) {
      expect(preview.systemRules.indexOf("Before the first tool call")).toBeLessThan(
        preview.systemRules.indexOf("Independent tool calls"),
      );
    }
    expect(preview.systemRules.includes("Independent tool calls")).toBe(toolBatching);
    expect(preview.systemRules.includes("return local file references as Markdown links")).toBe(fileLinks);
    expect(preview.basePrompt).not.toContain("<system_rules>");
    expect(preview.systemRules.includes("Reuse file content already in context")).toBe(fileContextReuse);
    expect(preview.basePrompt).toBe(basePrompt);
    expect(preview.basePrompt).not.toContain("Reuse file content already in context");
    expect(preview.systemRules.includes("When you have enough information to act, act.")).toBe(
      proactiveExecution,
    );
    expect(preview.basePrompt).not.toContain("When you have enough information to act, act.");
    if (proactiveExecution) {
      expect(preview.systemRules).toContain(
        "Always honor explicit user instructions to ask for confirmation",
      );
      expect(preview.systemRules).toContain("wait for that confirmation");
      expect(preview.systemRules).toContain("report findings without applying changes");
      expect(preview.systemRules).not.toContain("cannot answer questions mid-task");
      expect(preview.systemRules).not.toContain("not watching in real time");
    }
    await run(f, "show files");
    const prompt = (f.server.requests[0].messages as { role: string; content: string }[]).find(
      (message) => message.role === "system",
    )?.content;
    expect(prompt).toBe(preview.prompt);
    if (!communicationStyle && !toolBatching && !fileLinks && !fileContextReuse && !proactiveExecution) {
      expect(preview.systemRules).toBe("");
      expect(preview.prompt).toBe(preview.basePrompt);
    }
  },
);

test("snapshots prompt plugins on first send and keeps them when global settings change or the app restarts", async () => {
  const f = await fixture();
  f.settings.setCapabilityEnabled("communicationStyle", false);
  f.settings.setCapabilityEnabled("fileLinks", false);
  f.settings.setCapabilityEnabled("fileContextReuse", false);
  f.settings.setCapabilityEnabled("proactiveExecution", false);
  await run(f, "first send");
  f.settings.setCapabilityEnabled("communicationStyle", true);
  f.settings.setCapabilityEnabled("fileLinks", true);
  f.settings.setCapabilityEnabled("toolBatching", false);
  f.settings.setCapabilityEnabled("fileContextReuse", true);
  f.settings.setCapabilityEnabled("proactiveExecution", true);
  await f.host.close();
  const host = new SessionHost(f.dir, new SettingsStore(f.dir, codec), f.resources, f.workspace, undefined);
  await host.init();
  cleanup.push(() => host.close());
  await host.startRun({ sessionId: f.session.id, text: "old conversation" });
  await host.activeRuns.get(f.session.id)?.done;
  const system = () =>
    ((f.server.requests.at(-1)?.messages ?? []) as { role: string; content: string }[]).find(
      (message) => message.role === "system",
    )?.content ?? "";
  expect(system()).not.toContain("Before the first tool call");
  expect(system()).toContain("Independent tool calls");
  expect(system()).not.toContain("return local file references as Markdown links");
  expect(system()).not.toContain("Reuse file content already in context");
  expect(system()).not.toContain("When you have enough information to act, act.");
  const next = host.createSession(null);
  await host.startRun({ sessionId: next.id, text: "new conversation" });
  await host.activeRuns.get(next.id)?.done;
  expect(system()).toContain("Before the first tool call");
  expect(system()).not.toContain("Independent tool calls");
  expect(system()).toContain("return local file references as Markdown links");
  expect(system()).toContain("Reuse file content already in context");
  expect(system()).toContain("When you have enough information to act, act.");
});

test("defaults all plugin capabilities on and preserves saved choices in SQLite", async () => {
  const f = await fixture();
  expect(f.settings.get().capabilities).toEqual({
    communicationStyle: true,
    subagents: true,
    askUserQuestion: true,
    toolBatching: true,
    fileLinks: true,
    fileContextReuse: true,
    proactiveExecution: true,
  });
  const settings = f.settings.state.getSetting<Record<string, unknown>>("app");
  f.settings.setCapabilityEnabled("askUserQuestion", false);
  const restored = new SettingsStore(f.dir, codec);
  expect(restored.get().capabilities).toEqual({
    communicationStyle: true,
    subagents: true,
    askUserQuestion: false,
    toolBatching: true,
    fileLinks: true,
    fileContextReuse: true,
    proactiveExecution: true,
  });
  expect(() => restored.setCapabilityEnabled("unknown" as "fileLinks", true)).toThrow("无效插件能力");
  restored.setCapabilityEnabled("communicationStyle", false);
  restored.setCapabilityEnabled("subagents", false);
  restored.setCapabilityEnabled("fileLinks", false);
  restored.setCapabilityEnabled("fileContextReuse", false);
  restored.setCapabilityEnabled("proactiveExecution", false);
  const saved = new SettingsStore(f.dir, codec).get();
  expect(saved.capabilities.communicationStyle).toBe(false);
  expect(saved.capabilities.subagents).toBe(false);
  expect(saved.capabilities.askUserQuestion).toBe(false);
  expect(saved.capabilities.fileContextReuse).toBe(false);
  expect(saved.capabilities.proactiveExecution).toBe(false);
  expect(new SettingsStore(f.dir, codec).get().capabilities.fileLinks).toBe(false);
  f.settings.state.setSetting("app", {
    ...settings,
    capabilities: { ...f.settings.get().capabilities, communicationStyle: "on" },
  });
  expect(() => new SettingsStore(f.dir, codec)).toThrow("Invalid plugin capabilities");
  f.settings.state.setSetting("app", { ...settings, capabilities: true });
  expect(() => new SettingsStore(f.dir, codec)).toThrow("Invalid plugin capabilities");
});

test.each(["communicationStyle", "fileContextReuse", "proactiveExecution"] as const)(
  "sessions created before the %s switch keep their prompt when reopened",
  async (capability) => {
    const f = await fixture();
    f.settings.setCapabilityEnabled(capability, false);
    await run(f, "legacy conversation");
    await f.host.close();
    const task = f.settings.state.getTask(f.session.id);
    if (!task) throw new Error("Missing task fixture");
    const configuration = { ...(task.frozenConfiguration as Record<string, unknown>) };
    delete configuration[capability];
    f.settings.state.upsertTask({ ...task, frozenConfiguration: configuration });
    f.settings.setCapabilityEnabled(capability, true);
    const host = new SessionHost(f.dir, new SettingsStore(f.dir, codec), f.resources, f.workspace, undefined);
    await host.init();
    cleanup.push(() => host.close());
    await host.startRun({ sessionId: f.session.id, text: "continue legacy conversation" });
    await host.activeRuns.get(f.session.id)?.done;
    expect(JSON.stringify(f.server.requests.at(-1)?.messages)).not.toContain(
      {
        communicationStyle: "Before the first tool call",
        fileContextReuse: "Reuse file content already in context",
        proactiveExecution: "When you have enough information to act, act.",
      }[capability],
    );
  },
);

test("session paths resolve to the real JSONL file and reject missing session IDs", async () => {
  const f = await fixture();
  await run(f, "find my history");
  const path = f.host.sessionPath(f.session.id);
  expect(path).toBe(join(f.dir, "agent", "sessions", "_unassigned", `${f.session.id}.jsonl`));
  expect(await readFile(path, "utf8")).toContain("find my history");
  expect(() => f.host.sessionPath("../other")).toThrow("会话不存在");
});

test("rejects an invalid communication switch in a saved conversation before sending a model request", async () => {
  const f = await fixture();
  await run(f, "first send");
  await f.host.close();
  const task = f.settings.state.getTask(f.session.id);
  if (!task) throw new Error("Missing task fixture");
  f.settings.state.upsertTask({
    ...task,
    frozenConfiguration: {
      ...(task.frozenConfiguration as Record<string, unknown>),
      communicationStyle: "on",
    },
  });
  const host = new SessionHost(f.dir, new SettingsStore(f.dir, codec), f.resources, f.workspace, undefined);
  cleanup.push(() => host.close());
  await host.init();
  await expect(host.startRun({ sessionId: f.session.id, text: "continue" })).rejects.toThrow(
    "Invalid communication style capability",
  );
  expect(f.server.requests).toHaveLength(1);
});
