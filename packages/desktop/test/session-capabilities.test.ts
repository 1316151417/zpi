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
  "custom instructions rules follow independent switches: communication=%s, batching=%s, links=%s, reuse=%s, proactive=%s",
  async (communicationStyle, toolBatching, fileLinks, fileContextReuse, proactiveExecution) => {
    const f = await fixture();
    f.settings.setPluginEnabled("zpi.collaboration", false);
    const basePrompt = (await f.host.previewPrompt()).basePrompt;
    f.settings.setPluginEnabled("zpi.communication-style", communicationStyle);
    f.settings.setPluginEnabled("zpi.tool-batching", toolBatching);
    f.settings.setPluginEnabled("zpi.file-links", fileLinks);
    f.settings.setPluginEnabled("zpi.file-context-reuse", fileContextReuse);
    f.settings.setPluginEnabled("zpi.proactive-execution", proactiveExecution);
    const preview = await f.host.previewPrompt();
    for (const rule of [
      "Before the first tool call",
      "all answers, conclusions, and deliverables",
      "use clear, complete sentences",
      "answer simple questions directly in prose",
      "add comments only for constraints the code cannot express",
    ]) {
      expect(preview.customInstructions.includes(rule)).toBe(communicationStyle);
      expect(preview.basePrompt).not.toContain(rule);
    }
    if (communicationStyle && toolBatching) {
      expect(preview.customInstructions.indexOf("Before the first tool call")).toBeLessThan(
        preview.customInstructions.indexOf("Independent tool calls"),
      );
    }
    expect(preview.customInstructions.includes("Independent tool calls")).toBe(toolBatching);
    expect(preview.customInstructions.includes("return local file references as Markdown links")).toBe(
      fileLinks,
    );
    expect(preview.basePrompt).not.toContain("<system_rules>");
    expect(preview.customInstructions.includes("Reuse file content already in context")).toBe(
      fileContextReuse,
    );
    expect(preview.basePrompt).toBe(basePrompt);
    expect(preview.basePrompt).not.toContain("Reuse file content already in context");
    expect(preview.customInstructions.includes("When you have enough information to act, act.")).toBe(
      proactiveExecution,
    );
    expect(preview.basePrompt).not.toContain("When you have enough information to act, act.");
    if (proactiveExecution) {
      expect(preview.customInstructions).toContain(
        "Always honor explicit user instructions to ask for confirmation",
      );
      expect(preview.customInstructions).toContain("wait for that confirmation");
      expect(preview.customInstructions).toContain("report findings without applying changes");
      expect(preview.customInstructions).not.toContain("cannot answer questions mid-task");
      expect(preview.customInstructions).not.toContain("not watching in real time");
    }
    await run(f, "show files");
    const prompt = (f.server.requests[0].messages as { role: string; content: string }[]).find(
      (message) => message.role === "system",
    )?.content;
    expect(prompt).toBe(preview.prompt);
    if (!communicationStyle && !toolBatching && !fileLinks && !fileContextReuse && !proactiveExecution) {
      expect(preview.customInstructions).toBe("");
      expect(preview.prompt).toBe(preview.basePrompt);
    }
  },
);

test("snapshots custom instructions on first send and keeps them when global settings change or the app restarts", async () => {
  const f = await fixture();
  f.settings.setPluginEnabled("zpi.communication-style", false);
  f.settings.setPluginEnabled("zpi.file-links", false);
  f.settings.setPluginEnabled("zpi.file-context-reuse", false);
  f.settings.setPluginEnabled("zpi.proactive-execution", false);
  await run(f, "first send");
  f.settings.setPluginEnabled("zpi.communication-style", true);
  f.settings.setPluginEnabled("zpi.file-links", true);
  f.settings.setPluginEnabled("zpi.tool-batching", false);
  f.settings.setPluginEnabled("zpi.file-context-reuse", true);
  f.settings.setPluginEnabled("zpi.proactive-execution", true);
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
  const next = await host.createSession(null);
  await host.startRun({ sessionId: next.id, text: "new conversation" });
  await host.activeRuns.get(next.id)?.done;
  expect(system()).toContain("Before the first tool call");
  expect(system()).not.toContain("Independent tool calls");
  expect(system()).toContain("return local file references as Markdown links");
  expect(system()).toContain("Reuse file content already in context");
  expect(system()).toContain("When you have enough information to act, act.");
});

test("instruction and tool plugins persist through the same settings contract", async () => {
  const f = await fixture();
  expect(f.settings.get()).not.toHaveProperty("capabilities");
  expect(f.settings.get().plugins.enabled).toMatchObject({
    "zpi.questions": true,
    "zpi.collaboration": true,
    "zpi.web-search": false,
  });
  f.settings.setPluginEnabled("zpi.questions", false);
  f.settings.setPluginEnabled("zpi.communication-style", false);
  const restored = new SettingsStore(f.dir, codec);
  expect(restored.get().plugins.enabled["zpi.questions"]).toBe(false);
  expect(restored.get().plugins.enabled["zpi.communication-style"]).toBe(false);
  expect(() => restored.setPluginEnabled("unknown", true)).toThrow("无效插件");
});

test.each(["missing-runtime", "unknown-runtime", "different-version"])(
  "unavailable %s plugin blocks restoration before any model request",
  async (mode) => {
    const f = await fixture();
    await run(f, "freeze runtime plugins");
    await f.host.close();
    const task = f.settings.state.getTask(f.session.id);
    if (!task) throw new Error("Missing task fixture");
    const config = task.frozenConfiguration as { plugins: import("@zpi-dev/coding-agent").PluginSnapshot[] };
    const runtime = config.plugins.find((plugin) => plugin.id === "zpi.questions");
    if (!runtime) throw new Error("Missing runtime plugin fixture");
    if (mode === "missing-runtime") delete runtime.runtime;
    if (mode === "unknown-runtime") runtime.runtime = "unknown.runtime";
    if (mode === "different-version") runtime.version = "next";
    f.settings.state.upsertTask({ ...task, frozenConfiguration: config });
    const restored = new SessionHost(f.dir, new SettingsStore(f.dir, codec), f.resources, f.workspace);
    cleanup.push(() => restored.close());
    await restored.init();
    await expect(restored.startRun({ sessionId: f.session.id, text: "continue" })).rejects.toThrow(
      "运行时不可用或版本不匹配",
    );
    expect(f.server.requests).toHaveLength(1);
  },
);

test("frozen plugin versions, instructions and commands survive restart and global disabling", async () => {
  const f = await fixture();
  await run(f, "freeze plugins");
  await f.host.close();
  const task = f.settings.state.getTask(f.session.id);
  if (!task) throw new Error("Missing task fixture");
  const config = task.frozenConfiguration as { plugins: import("@zpi-dev/coding-agent").PluginSnapshot[] };
  const init = config.plugins.find((plugin) => plugin.id === "zpi.project-init");
  if (!init?.commands) throw new Error("Missing initialization plugin");
  init.version = "frozen-version";
  init.instructions = ["frozen plugin text"];
  init.commands = [{ name: "init", description: "Frozen init", prompt: "FROZEN INIT {{arguments}}" }];
  f.settings.state.upsertTask({ ...task, frozenConfiguration: config });
  f.settings.setPluginEnabled("zpi.project-init", false);
  const host = new SessionHost(f.dir, new SettingsStore(f.dir, codec), f.resources, f.workspace, undefined);
  await host.init();
  cleanup.push(() => host.close());
  expect(host.listCommands(f.session.id).map((command) => command.name)).toContain("init");
  expect(host.listCommands().map((command) => command.name)).not.toContain("init");
  await host.startRun({ sessionId: f.session.id, text: "/init preserve" });
  await host.activeRuns.get(f.session.id)?.done;
  expect(JSON.stringify(f.server.requests.at(-1)?.messages)).toContain("FROZEN INIT preserve");
  expect(JSON.stringify(f.server.requests.at(-1)?.messages)).toContain("frozen plugin text");
  const next = await host.createSession(null);
  expect(host.listCommands(next.id).map((command) => command.name)).not.toContain("init");
  await host.startRun({ sessionId: next.id, text: "/init plain input" });
  await host.activeRuns.get(next.id)?.done;
  expect(JSON.stringify(f.server.requests.at(-1)?.messages)).not.toContain("FROZEN INIT");
  expect(JSON.stringify(f.server.requests.at(-1)?.messages)).not.toContain("Inspect this project");
});

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
    "session configuration: unsupported option communicationStyle",
  );
  expect(f.server.requests).toHaveLength(1);
});
