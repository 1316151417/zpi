import { existsSync } from "node:fs";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { HookRunner } from "@zpi-dev/coding-agent";
import { expect, test, vi } from "vitest";
import { ConfiguredHooks } from "../src/main/plugins/configured-hooks.ts";
import { SessionHost } from "../src/main/session-host.ts";
import type { HookConfig } from "../src/shared/hooks.ts";
import { cleanup, fixture, run } from "./helpers/context-fixture.ts";

function command(text: string): HookConfig {
  return {
    event: "UserPromptSubmit",
    type: "process",
    command: process.execPath,
    args: ["-e", `process.stdout.write(JSON.stringify({additionalContext:${JSON.stringify(text)}}))`],
    timeoutMs: 5000,
    enabled: true,
  };
}

test("explicit hooks share user/project scope without writing project configuration", async () => {
  const f = await fixture();
  const projectDir = join(f.dir, "scoped-project");
  await mkdir(projectDir);
  const project = await f.host.addProject(projectDir);
  f.host.saveHook({ ...command("PROJECT_HOOK"), projectId: project.id });
  f.host.saveHook({ ...command("USER_HOOK"), projectId: null });
  const otherProjectDir = join(f.dir, "other-project");
  await mkdir(otherProjectDir);
  const otherProject = await f.host.addProject(otherProjectDir);
  expect(f.host.getHooks(project.id).hooks).toHaveLength(1);
  expect(f.host.getHooks(otherProject.id).hooks).toHaveLength(0);
  expect(f.host.configuredHooks.snapshot(project.id)[0].options?.hooks).toHaveLength(2);
  expect(f.host.configuredHooks.snapshot(otherProject.id)[0].options?.hooks).toHaveLength(1);
  const task = await f.host.createSession(project.id);
  await f.host.startRun({ sessionId: task.id, text: "Project hook admission" });
  await f.host.activeRuns.get(task.id)?.done;
  const messages = JSON.stringify(f.server.requests.at(-1)?.messages);
  expect(messages).toContain("USER_HOOK");
  expect(messages).toContain("PROJECT_HOOK");
  expect(messages.indexOf("USER_HOOK")).toBeLessThan(messages.indexOf("PROJECT_HOOK"));
  expect(await readdir(projectDir)).not.toContain(".zpi");
  expect(() => f.host.saveHook({ ...command("BAD_SCOPE"), projectId: "unknown-project" })).toThrow(
    "项目不存在",
  );
});

test("list, configuration and prompt preview never execute commands; accepted input executes them", async () => {
  const f = await fixture();
  const marker = join(f.dir, "hook-executed");
  f.host.saveHook({
    ...command("EXECUTED_CONTEXT"),
    projectId: null,
    args: [
      "-e",
      `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'executed');process.stdout.write('EXECUTED_CONTEXT')`,
    ],
  });
  expect(f.host.getHooks(null).hooks).toHaveLength(1);
  await f.host.previewPrompt();
  f.host.listCommands();
  expect(existsSync(marker)).toBe(false);
  await run(f, "Execute the configured hook");
  expect(existsSync(marker)).toBe(true);
  expect(JSON.stringify(f.server.requests.at(-1)?.messages)).toContain("EXECUTED_CONTEXT");
});

test("edited, disabled and deleted hooks affect new sessions while old sessions retain frozen commands after restart", async () => {
  const f = await fixture();
  const original = f.host.saveHook({ ...command("OLD_HOOK_CONTEXT"), projectId: null }).hooks[0];
  await run(f, "Freeze hook snapshot");
  const changed = f.host.saveHook({
    ...command("NEW_HOOK_CONTEXT"),
    projectId: null,
    id: original.id,
    expectedRevision: original.revision,
  }).hooks[0];
  expect(() =>
    f.host.deleteHook({ id: original.id, projectId: null, expectedRevision: original.revision }),
  ).toThrow("已更新");
  const next = await f.host.createSession(null);
  await f.host.startRun({ sessionId: next.id, text: "Use changed hook" });
  await f.host.activeRuns.get(next.id)?.done;
  expect(JSON.stringify(f.server.requests.at(-1)?.messages)).toContain("NEW_HOOK_CONTEXT");
  const disabled = f.host.setHookEnabled(
    { id: changed.id, projectId: null, expectedRevision: changed.revision },
    false,
  ).hooks[0];
  expect(f.host.configuredHooks.snapshot(null)).toEqual([]);
  f.host.deleteHook({ id: disabled.id, projectId: null, expectedRevision: disabled.revision });
  expect(f.host.getHooks(null).hooks).toEqual([]);
  await f.host.close();
  const restored = new SessionHost(f.dir, f.settings, f.resources, f.workspace);
  cleanup.push(() => restored.close());
  await restored.init();
  await restored.startRun({ sessionId: f.session.id, text: "Continue frozen hook after deletion" });
  await restored.activeRuns.get(f.session.id)?.done;
  expect(JSON.stringify(f.server.requests.at(-1)?.messages)).toContain("OLD_HOOK_CONTEXT");
  expect(JSON.stringify(f.server.requests.at(-1)?.messages)).not.toContain("NEW_HOOK_CONTEXT");
  const fresh = await restored.createSession(null);
  await restored.startRun({ sessionId: fresh.id, text: "No configured hooks" });
  await restored.activeRuns.get(fresh.id)?.done;
  expect(JSON.stringify(f.server.requests.at(-1)?.messages)).not.toContain("HOOK_CONTEXT");
});

test("tool matchers use the same aliases and exit 2 blocking as external plugin hooks", async () => {
  const f = await fixture();
  f.host.saveHook({
    ...command("unused"),
    projectId: null,
    event: "PreToolUse",
    matcher: "^Bash$",
    args: ["-e", "process.stderr.write('Review command first');process.exit(2)"],
  });
  const snapshot = f.host.configuredHooks.snapshot(null)[0];
  const runner = new HookRunner(f.host.configuredHooks.bind(snapshot).hooks ?? []);
  const base = {
    event: "PreToolUse" as const,
    sessionId: "test",
    cwd: f.workspace,
    toolCallId: "call",
    toolInput: {},
  };
  expect((await runner.run({ ...base, toolName: "read" })).block).toBe(false);
  expect(await runner.run({ ...base, toolName: "bash" })).toMatchObject({
    block: true,
    reason: "Review command first",
  });
  const tampered = structuredClone(snapshot);
  tampered.version = "invalid";
  expect(() => f.host.configuredHooks.bind(tampered)).toThrow("快照无效");
});

test.each([
  { event: "PermissionRequest" },
  { matcher: "[" },
  { timeoutMs: 0 },
  { timeoutMs: 300001 },
  { type: "http" },
  { enabled: "yes" },
  { command: "" },
  { args: [42] },
  { async: true },
])("invalid hook configuration is rejected without saving (%j)", async (change) => {
  const f = await fixture();
  expect(() => f.host.saveHook({ ...command("test"), projectId: null, ...change } as never)).toThrow();
  expect(f.host.getHooks(null).hooks).toEqual([]);
});

test("malformed stored hook lists fail closed", async () => {
  const f = await fixture();
  f.settings.state.setSetting("hooks.config", [null]);
  const hooks = new ConfiguredHooks(f.dir, f.settings.state);
  expect(() => hooks.snapshot(null)).toThrow("无效钩子记录");
});

test("collaboration exposes no input preparation hook and ordinary sends do not reparse Agent definitions", async () => {
  const f = await fixture();
  expect(f.host.getHooks(null).plugins.some((plugin) => plugin.id === "zpi.collaboration")).toBe(false);
  await run(f, "Initialize the session catalog");
  const agents = vi.spyOn(f.host.localPlugins, "agents");
  try {
    await run(f, "Ordinary follow-up");
    await f.host.listSessionCustomCommands(f.session.id);
    expect(agents).not.toHaveBeenCalled();
  } finally {
    agents.mockRestore();
  }
});

test("external plugin hooks are shown separately and follow their plugin state", async () => {
  const f = await fixture();
  const source = join(f.dir, "plugin-with-hooks");
  await mkdir(join(source, ".claude-plugin"), { recursive: true });
  await mkdir(join(source, "hooks"));
  await writeFile(
    join(source, ".claude-plugin/plugin.json"),
    JSON.stringify({ name: "hook-example", version: "1" }),
  );
  await writeFile(
    join(source, "hooks/hooks.json"),
    JSON.stringify({
      hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: "echo PLUGIN_CONTEXT" }] }] },
    }),
  );
  const plugin = await f.host.localPlugins.import(source);
  expect(f.host.getHooks(null).plugins.find((group) => group.id === plugin.id)).toMatchObject({
    enabled: false,
    builtin: false,
    hooks: [{ event: "UserPromptSubmit", command: "echo PLUGIN_CONTEXT", type: "command" }],
  });
  f.settings.setPluginEnabled(plugin.id, true);
  expect(f.host.getHooks(null).plugins.find((group) => group.id === plugin.id)?.enabled).toBe(true);
  expect(f.host.getHooks(null).hooks).toEqual([]);
  expect(f.server.requests).toHaveLength(0);
});

test("reusing host hook bindings still rejects changed plugin files before the next run", async () => {
  const f = await fixture();
  const source = join(f.dir, "skill-plugin");
  await mkdir(join(source, ".claude-plugin"), { recursive: true });
  await mkdir(join(source, "skills/inspect"), { recursive: true });
  await writeFile(
    join(source, ".claude-plugin/plugin.json"),
    JSON.stringify({ name: "inspect", version: "1" }),
  );
  await writeFile(
    join(source, "skills/inspect/SKILL.md"),
    "---\nname: inspect\ndescription: Inspect\n---\nOriginal instructions",
  );
  const plugin = await f.host.localPlugins.import(source);
  f.settings.setPluginEnabled(plugin.id, true);
  f.settings.setPluginEnabled("zpi.session-title", false);
  await run(f, "First run");
  const root = plugin.options?.root;
  if (typeof root !== "string") throw new Error("Missing plugin cache");
  await writeFile(join(root, "skills/inspect/SKILL.md"), "Changed instructions");
  const requests = f.server.requests.length;
  await expect(f.host.startRun({ sessionId: f.session.id, text: "Second run" })).rejects.toThrow(
    "缓存内容已改变",
  );
  expect(f.server.requests).toHaveLength(requests);
});
