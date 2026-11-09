import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { desktopPluginIds } from "@zpi-dev/builtin-plugins";
import { expect, test, vi } from "vitest";
import { SessionHost } from "../src/main/session-host.ts";
import { cleanup, fixture, run } from "./helpers/context-fixture.ts";

test("title, notification and memory policies follow frozen plugin enablement across restart", async () => {
  const f = await fixture();
  const notify = vi.fn();
  f.host.setNotificationSink(notify);
  f.settings.setPluginOptions(desktopPluginIds.memory, { mode: "long" });
  const memory = vi
    .spyOn(f.host.plugins.longMemory, "context")
    .mockResolvedValue({ instructions: ["FROZEN_MEMORY"], sources: [] });
  vi.spyOn(f.host.plugins.longMemory, "check").mockResolvedValue();
  await run(f, "Freeze policy plugins");
  expect(memory).toHaveBeenCalled();
  expect(notify).toHaveBeenCalledTimes(1);
  expect(f.host.sessions.get(f.session.id)?.systemPrompt).toContain("FROZEN_MEMORY");
  const originalTitles = f.server.titleRequests.length;
  for (const id of [desktopPluginIds.memory, desktopPluginIds.title, desktopPluginIds.notifications])
    f.settings.setPluginEnabled(id, false);
  const next = await f.host.createSession(null);
  memory.mockClear();
  notify.mockClear();
  await f.host.startRun({ sessionId: next.id, text: "Disabled policy plugins" });
  await f.host.activeRuns.get(next.id)?.done;
  expect(memory).not.toHaveBeenCalled();
  expect(notify).not.toHaveBeenCalled();
  expect(f.server.titleRequests).toHaveLength(originalTitles);
  await f.host.close();
  const restored = new SessionHost(f.dir, f.settings, f.resources, f.workspace);
  cleanup.push(() => restored.close());
  await restored.init();
  const restoredMemory = vi
    .spyOn(restored.plugins.longMemory, "context")
    .mockResolvedValue({ instructions: ["RESTORED_FROZEN_MEMORY"], sources: [] });
  vi.spyOn(restored.plugins.longMemory, "check").mockResolvedValue();
  restored.setNotificationSink(notify);
  await restored.startRun({ sessionId: f.session.id, text: "Continue frozen policy" });
  await restored.activeRuns.get(f.session.id)?.done;
  expect(restoredMemory).not.toHaveBeenCalled();
  expect(notify).toHaveBeenCalledTimes(1);
  expect(restored.sessions.get(f.session.id)?.systemPrompt).toContain("FROZEN_MEMORY");
  expect(restored.sessions.get(f.session.id)?.systemPrompt).not.toContain("RESTORED_FROZEN_MEMORY");
});

test("local plugins share command and prompt assembly, keep imported versions, and contribute agents and skills", async () => {
  const f = await fixture();
  const source = join(f.dir, "plugin-source");
  await mkdir(join(source, ".zcode-plugin"), { recursive: true });
  await mkdir(join(source, "commands"));
  await mkdir(join(source, "skills", "guide"), { recursive: true });
  await mkdir(join(source, "agents"));
  await writeFile(
    join(source, ".zcode-plugin", "plugin.json"),
    JSON.stringify({ name: "example", version: "1", instructions: ["FROZEN_PLUGIN_INSTRUCTION"] }),
  );
  await writeFile(
    join(source, "commands", "review.md"),
    "---\ndescription: Review\n---\nFROZEN_REVIEW $ARGUMENTS",
  );
  await writeFile(
    join(source, "skills", "guide", "SKILL.md"),
    "---\ndescription: Plugin skill guide\n---\nFROZEN_SKILL_BODY",
  );
  await writeFile(
    join(source, "agents", "reviewer.md"),
    "---\nname: reviewer\ndescription: Review carefully\ntools: Read, Bash\n---\nFROZEN_AGENT_PROMPT",
  );
  const plugin = await f.host.localPlugins.import(source);
  f.settings.setPluginEnabled(plugin.id, true);
  expect(f.host.listCommands().map((entry) => entry.name)).toContain("example:review");
  expect((await f.host.previewPrompt()).prompt).toContain("example:guide");
  expect(f.host.listSubagents(null).agents.find((agent) => agent.name === "example:reviewer")?.tools).toEqual(
    ["read", "bash"],
  );
  await run(f, "/example:review literal $1");
  expect(JSON.stringify(f.server.requests.at(-1)?.messages)).toContain("FROZEN_REVIEW literal $1");
  expect(JSON.stringify(f.server.requests.at(-1)?.messages)).toContain("FROZEN_PLUGIN_INSTRUCTION");
  const skill = await f.host.sessions.get(f.session.id)?.loadSkill("example:guide");
  expect(skill?.body).toBe("FROZEN_SKILL_BODY");
  expect((await f.host.listSessionSkills(f.session.id)).skills.map((skill) => skill.name)).toContain(
    "example:guide",
  );
  await writeFile(join(source, "commands", "review.md"), "NEW_REVIEW $ARGUMENTS");
  await f.host.localPlugins.import(source);
  f.settings.setPluginEnabled(plugin.id, false);
  await f.host.close();
  const restored = new SessionHost(f.dir, f.settings, f.resources, f.workspace);
  cleanup.push(() => restored.close());
  await restored.init();
  expect(restored.listCommands().map((entry) => entry.name)).not.toContain("example:review");
  await restored.startRun({ sessionId: f.session.id, text: "/example:review after restart" });
  await restored.activeRuns.get(f.session.id)?.done;
  expect(JSON.stringify(f.server.requests.at(-1)?.messages)).toContain("FROZEN_REVIEW after restart");
  expect(JSON.stringify(f.server.requests.at(-1)?.messages)).not.toContain("NEW_REVIEW");
});

test("a throwing notification sink cannot strand run settlement", async () => {
  const f = await fixture();
  f.host.setNotificationSink(() => {
    throw new Error("Notification delivery failed");
  });
  await run(f, "Complete despite optional notification failure");
  expect(f.host.activeRuns.has(f.session.id)).toBe(false);
  expect(f.host.getSessionSnapshot(f.session.id).view.runs.at(-1)?.status).toBe("completed");
});

test("disabled local plugins remain manageable when their cached files are missing", async () => {
  const f = await fixture();
  const source = join(f.dir, "disabled-plugin");
  await mkdir(join(source, ".claude-plugin"), { recursive: true });
  await writeFile(
    join(source, ".claude-plugin", "plugin.json"),
    JSON.stringify({ name: "disabled", version: "1" }),
  );
  const plugin = await f.host.localPlugins.import(source);
  await writeFile(join(String(plugin.options?.root), ".claude-plugin", "plugin.json"), "{broken");
  f.settings.setPluginEnabled(plugin.id, false);
  expect(f.host.localPlugins.list().map((entry) => entry.id)).toContain(plugin.id);
  expect(() => f.host.listCommands()).not.toThrow();
  f.settings.setPluginEnabled(plugin.id, true);
  // 候选只读声明；完整文件校验在实际执行前异步完成，避免预览阻塞主进程。
  expect(() => f.host.listCommands()).not.toThrow();
  await expect(f.host.startRun({ sessionId: f.session.id, text: "verify before execution" })).rejects.toThrow(
    "缓存内容已改变",
  );
  expect(f.server.requests).toHaveLength(0);
});
