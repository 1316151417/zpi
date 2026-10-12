import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { SessionHost } from "../src/main/session-host.ts";
import { SettingsStore } from "../src/main/storage.ts";
import { cleanup, codec, fixture, run } from "./helpers/context-fixture.ts";

test.each([
  [true, true],
  [true, false],
  [false, true],
  [false, false],
])(
  "plugin prompt rules follow independent switches: batching=%s, links=%s",
  async (toolBatching, fileLinks) => {
    const f = await fixture();
    f.settings.setCapabilityEnabled("toolBatching", toolBatching);
    f.settings.setCapabilityEnabled("fileLinks", fileLinks);
    const preview = await f.host.previewPrompt();
    expect(preview.systemRules.includes("Independent tool calls")).toBe(toolBatching);
    expect(preview.systemRules.includes("return local file references as Markdown links")).toBe(fileLinks);
    expect(preview.basePrompt).not.toContain("<system_rules>");
    await run(f, "show files");
    const prompt = (f.server.requests[0].messages as { role: string; content: string }[]).find(
      (message) => message.role === "system",
    )?.content;
    expect(prompt).toBe(preview.prompt);
    if (!toolBatching && !fileLinks) {
      expect(preview.systemRules).toBe("");
      expect(preview.prompt).toBe(preview.basePrompt);
    }
  },
);

test("snapshots prompt plugins on first send and keeps them when global settings change or the app restarts", async () => {
  const f = await fixture();
  f.settings.setCapabilityEnabled("fileLinks", false);
  await run(f, "first send");
  f.settings.setCapabilityEnabled("fileLinks", true);
  f.settings.setCapabilityEnabled("toolBatching", false);
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
  const next = host.createSession(null);
  await host.startRun({ sessionId: next.id, text: "new conversation" });
  await host.activeRuns.get(next.id)?.done;
  expect(system()).not.toContain("Independent tool calls");
  expect(system()).toContain("return local file references as Markdown links");
});

test("migrates previous plugin settings without changing existing prompt behavior and rejects unknown capabilities", async () => {
  const f = await fixture();
  const path = join(f.dir, "settings.json");
  const settings = JSON.parse(await readFile(path, "utf8"));
  await writeFile(path, JSON.stringify({ ...settings, capabilities: { askUserQuestion: true } }));
  const restored = new SettingsStore(f.dir, codec);
  expect(restored.get().capabilities).toEqual({
    subagents: false,
    askUserQuestion: true,
    toolBatching: true,
    fileLinks: true,
  });
  expect(() => restored.setCapabilityEnabled("unknown" as "fileLinks", true)).toThrow("无效插件能力");
  restored.setCapabilityEnabled("fileLinks", false);
  expect(new SettingsStore(f.dir, codec).get().capabilities.fileLinks).toBe(false);
  await writeFile(path, JSON.stringify({ ...settings, capabilities: true }));
  expect(() => new SettingsStore(f.dir, codec)).toThrow("Invalid plugin capabilities");
});

test("session paths resolve to the real JSONL file and reject missing session IDs", async () => {
  const f = await fixture();
  await run(f, "find my history");
  const path = f.host.sessionPath(f.session.id);
  expect(path).toBe(join(f.dir, "agent", "sessions", "_unassigned", `${f.session.id}.jsonl`));
  expect(await readFile(path, "utf8")).toContain("find my history");
  expect(() => f.host.sessionPath("../other")).toThrow("会话不存在");
});
