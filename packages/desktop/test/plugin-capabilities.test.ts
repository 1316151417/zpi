import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { SessionHost } from "../src/main/session-host.ts";
import { SettingsStore } from "../src/main/storage.ts";
import { cleanup, codec, fixture, run } from "./helpers/context-fixture.ts";

test.each([
  [true, true, true],
  [true, true, false],
  [true, false, true],
  [true, false, false],
  [false, true, true],
  [false, true, false],
  [false, false, true],
  [false, false, false],
])(
  "plugin prompt rules follow independent switches: batching=%s, links=%s, reuse=%s",
  async (toolBatching, fileLinks, fileContextReuse) => {
    const f = await fixture();
    f.settings.setCapabilityEnabled("subagents", false);
    const basePrompt = (await f.host.previewPrompt()).basePrompt;
    f.settings.setCapabilityEnabled("toolBatching", toolBatching);
    f.settings.setCapabilityEnabled("fileLinks", fileLinks);
    f.settings.setCapabilityEnabled("fileContextReuse", fileContextReuse);
    const preview = await f.host.previewPrompt();
    expect(preview.systemRules.includes("Independent tool calls")).toBe(toolBatching);
    expect(preview.systemRules.includes("return local file references as Markdown links")).toBe(fileLinks);
    expect(preview.basePrompt).not.toContain("<system_rules>");
    expect(preview.systemRules.includes("Reuse file content already in context")).toBe(fileContextReuse);
    expect(preview.basePrompt).toBe(basePrompt);
    expect(preview.basePrompt).not.toContain("Reuse file content already in context");
    await run(f, "show files");
    const prompt = (f.server.requests[0].messages as { role: string; content: string }[]).find(
      (message) => message.role === "system",
    )?.content;
    expect(prompt).toBe(preview.prompt);
    if (!toolBatching && !fileLinks && !fileContextReuse) {
      expect(preview.systemRules).toBe("");
      expect(preview.prompt).toBe(preview.basePrompt);
    }
  },
);

test("snapshots prompt plugins on first send and keeps them when global settings change or the app restarts", async () => {
  const f = await fixture();
  f.settings.setCapabilityEnabled("fileLinks", false);
  f.settings.setCapabilityEnabled("fileContextReuse", false);
  await run(f, "first send");
  f.settings.setCapabilityEnabled("fileLinks", true);
  f.settings.setCapabilityEnabled("toolBatching", false);
  f.settings.setCapabilityEnabled("fileContextReuse", true);
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
  expect(system()).toContain("Independent tool calls");
  expect(system()).not.toContain("return local file references as Markdown links");
  expect(system()).not.toContain("Reuse file content already in context");
  const next = host.createSession(null);
  await host.startRun({ sessionId: next.id, text: "new conversation" });
  await host.activeRuns.get(next.id)?.done;
  expect(system()).not.toContain("Independent tool calls");
  expect(system()).toContain("return local file references as Markdown links");
  expect(system()).toContain("Reuse file content already in context");
});

test("defaults all plugin capabilities on and preserves saved choices when filling missing settings", async () => {
  const f = await fixture();
  expect(f.settings.get().capabilities).toEqual({
    subagents: true,
    askUserQuestion: true,
    toolBatching: true,
    fileLinks: true,
    fileContextReuse: true,
  });
  expect(f.settings.get().interface.askUserQuestionAutoResolutionEnabled).toBe(true);
  const path = join(f.dir, "settings.json");
  const settings = JSON.parse(await readFile(path, "utf8"));
  await writeFile(path, JSON.stringify({ ...settings, capabilities: { askUserQuestion: false } }));
  const restored = new SettingsStore(f.dir, codec);
  expect(restored.get().capabilities).toEqual({
    subagents: true,
    askUserQuestion: false,
    toolBatching: true,
    fileLinks: true,
    fileContextReuse: true,
  });
  expect(() => restored.setCapabilityEnabled("unknown" as "fileLinks", true)).toThrow("无效插件能力");
  restored.setCapabilityEnabled("subagents", false);
  restored.setCapabilityEnabled("fileLinks", false);
  restored.setCapabilityEnabled("fileContextReuse", false);
  restored.updatePreferences({ askUserQuestionAutoResolutionEnabled: false });
  const saved = new SettingsStore(f.dir, codec).get();
  expect(saved.capabilities.subagents).toBe(false);
  expect(saved.capabilities.askUserQuestion).toBe(false);
  expect(saved.capabilities.fileContextReuse).toBe(false);
  expect(saved.interface.askUserQuestionAutoResolutionEnabled).toBe(false);
  expect(new SettingsStore(f.dir, codec).get().capabilities.fileLinks).toBe(false);
  await writeFile(path, JSON.stringify({ ...settings, capabilities: true }));
  expect(() => new SettingsStore(f.dir, codec)).toThrow("Invalid plugin capabilities");
});

test("sessions created before the reuse switch keep their prompt when reopened", async () => {
  const f = await fixture();
  f.settings.setCapabilityEnabled("fileContextReuse", false);
  await run(f, "legacy conversation");
  const path = f.host.sessionPath(f.session.id);
  await f.host.close();
  const rows = (await readFile(path, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  for (const row of rows) if (row.customType === "zpi.configuration") delete row.data.fileContextReuse;
  await writeFile(path, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
  f.settings.setCapabilityEnabled("fileContextReuse", true);
  const host = new SessionHost(f.dir, new SettingsStore(f.dir, codec), f.resources, f.workspace, undefined);
  await host.init();
  cleanup.push(() => host.close());
  await host.startRun({ sessionId: f.session.id, text: "continue legacy conversation" });
  await host.activeRuns.get(f.session.id)?.done;
  expect(JSON.stringify(f.server.requests.at(-1)?.messages)).not.toContain(
    "Reuse file content already in context",
  );
});

test("session paths resolve to the real JSONL file and reject missing session IDs", async () => {
  const f = await fixture();
  await run(f, "find my history");
  const path = f.host.sessionPath(f.session.id);
  expect(path).toBe(join(f.dir, "agent", "sessions", "_unassigned", `${f.session.id}.jsonl`));
  expect(await readFile(path, "utf8")).toContain("find my history");
  expect(() => f.host.sessionPath("../other")).toThrow("会话不存在");
});
