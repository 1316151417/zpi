import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test, vi } from "vitest";
import { assembleSession, createCodingTools, type PluginSnapshot } from "zpi-coding-agent";
import { desktopPluginManifests } from "../src/index.ts";
import { defaultMemorySettings } from "../src/memory/types.ts";
import type { BuiltinPluginPorts, PluginConfiguration, PluginSessionRecord } from "../src/ports.ts";
import { BuiltinPluginRuntime } from "../src/runtime.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "zpi-builtin-runtime-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const settings = new Map<string, unknown>();
  const records = new Map<string, PluginSessionRecord>([
    ["owner", { id: "owner", projectId: null, title: "Task", createdAt: 1, updatedAt: 1 }],
  ]);
  const snapshots: PluginSnapshot[] = structuredClone([...desktopPluginManifests]);
  const config: PluginConfiguration = { plugins: snapshots };
  const ports: BuiltinPluginPorts = {
    directory,
    homeDirectory: directory,
    storage: {
      getSetting<T>(key: string) {
        return settings.get(key) as T | undefined;
      },
      setSetting: (key, value) => {
        settings.set(key, value);
      },
      setRuntime: vi.fn(),
    },
    sessions: {
      get: (id) => records.get(id),
      records: () => records.values(),
      cwd: () => directory,
      configuration: () => config,
      configure: vi.fn(),
      state: () => ({ titleState: "new" }),
      update: vi.fn(),
      createChild: vi.fn(async () => "child"),
      delete: vi.fn(async () => {}),
      select: vi.fn(),
      run: vi.fn(async () => {}),
      active: () => undefined,
      stop: vi.fn(async () => {}),
      closed: (id) => !records.has(id),
      deleting: () => false,
      changing: () => false,
      blocked: () => false,
      history: () => ({
        snapshot: () => ({ generation: "generation", endSeq: 0 }),
        readReverse: () => [],
        readRange: () => [],
      }),
    },
    models: {
      valid: () => true,
      selection: () => null,
      create: vi.fn(() => {
        throw new Error("Unexpected model call");
      }),
    },
    memorySettings: () => structuredClone(defaultMemorySettings),
    files: { preview: async () => ({ kind: "text", text: "" }) },
    credentials: () => "",
    fetch: vi.fn(async () => {
      throw new Error("Unexpected network call");
    }),
    closing: () => false,
    publish: vi.fn(),
    titleChanged: vi.fn(),
    notify: vi.fn(() => true),
    error: vi.fn(),
  };
  const runtime = new BuiltinPluginRuntime(ports);
  cleanup.push(async () => {
    await runtime.close();
    await runtime.drain();
  });
  return { runtime, ports, snapshots, directory, records };
}

test("all seven runtimes assemble with generic ports and preview performs no execution", async () => {
  const { runtime, ports, snapshots, directory } = await fixture();
  const contributions = runtime.contributions(
    snapshots,
    { sessionId: "preview", cwd: directory, preview: true },
    { validate: () => {}, bind: (snapshot) => snapshot, agents: () => [] },
  );
  const assembly = assembleSession({ ...contributions, builtinTools: createCodingTools(directory) });
  expect(contributions.plugins?.slice(0, 7).map((plugin) => plugin.runtime)).toEqual([
    "desktop.questions",
    "desktop.web-search",
    "desktop.collaboration",
    "desktop.background-tasks",
    "desktop.memory",
    "desktop.session-title",
    "desktop.notifications",
  ]);
  const tools = assembly.activeTools.map((tool) => tool.name);
  expect(tools).toEqual(
    expect.arrayContaining([
      "AskUserQuestion",
      "web_search",
      "web_fetch",
      "Agent",
      "SendMessage",
      "TaskOutput",
      "TaskStop",
    ]),
  );
  expect(tools.filter((name) => name === "TaskOutput")).toHaveLength(1);
  expect(Object.values(assembly.getContextSections()).join("\n")).toContain("Available agent types");
  expect(ports.models.create).not.toHaveBeenCalled();
  expect(ports.fetch).not.toHaveBeenCalled();
  expect(ports.sessions.run).not.toHaveBeenCalled();
  expect(ports.storage.setRuntime).not.toHaveBeenCalled();
  expect(await readdir(directory)).toEqual([]);
});

test("imported Agent definitions are loaded only when collaboration requests them", async () => {
  const { runtime, snapshots, directory } = await fixture();
  const agents = vi.fn(() => []);
  const external = { validate: () => {}, bind: (snapshot: PluginSnapshot) => snapshot, agents };
  const context = { sessionId: "preview", cwd: directory, preview: true };
  const disabled = runtime.contributions(
    snapshots.filter((plugin) => plugin.runtime !== "desktop.collaboration"),
    context,
    external,
  );
  assembleSession({ ...disabled, builtinTools: createCodingTools(directory) }).getContextSections();
  expect(agents).not.toHaveBeenCalled();

  const enabled = runtime.contributions(snapshots, context, external);
  expect(agents).not.toHaveBeenCalled();
  assembleSession({ ...enabled, builtinTools: createCodingTools(directory) }).getContextSections();
  expect(agents).toHaveBeenCalledOnce();
});

test("ordinary messages skip Agent parsing while mentions still resolve", async () => {
  const { runtime } = await fixture();
  const imported = vi.fn(() => []);
  expect(runtime.agentRequest("owner", "An ordinary user message", imported)).toBeUndefined();
  expect(imported).not.toHaveBeenCalled();

  const agent = runtime.listSubagents("owner", []).agents[0];
  if (!agent) throw new Error("Missing builtin agent");
  expect(runtime.agentRequest("owner", `@${agent.name} Inspect the task`, imported)).toEqual({
    agent: agent.name,
    prompt: "Inspect the task",
  });
  expect(imported).toHaveBeenCalledOnce();
});

test.each(["disabled", "child"])(
  "slash suggestions skip imported Agent parsing for %s collaboration",
  async (mode) => {
    const { runtime, ports } = await fixture();
    const original = ports.sessions.configuration("owner");
    const profile = runtime.listSubagents("owner", []).agents[0];
    if (!profile) throw new Error("Missing builtin agent");
    const configuration = vi
      .spyOn(ports.sessions, "configuration")
      .mockReturnValue(
        mode === "disabled" ? { ...original, plugins: [] } : { ...original, subagentProfile: profile },
      );
    const imported = vi.fn(() => []);
    expect(runtime.commandSubagents("owner", imported)).toEqual([]);
    expect(imported).not.toHaveBeenCalled();

    configuration.mockReturnValue(original);
    expect(runtime.commandSubagents("owner", imported)).toContainEqual(profile);
    expect(imported).toHaveBeenCalledOnce();
  },
);

test("plugin shutdown attempts every owner and retains original failures", async () => {
  const { runtime } = await fixture();
  const failure = new Error("memory failed to close");
  const first = vi.spyOn(runtime.longMemory, "close").mockRejectedValueOnce(failure);
  const collaboration = vi.spyOn(runtime.collaboration, "close");
  const background = vi.spyOn(runtime.background, "close");
  const titles = vi.spyOn(runtime.titles, "close");
  const notifications = vi.spyOn(runtime.notifications, "close");
  await expect(runtime.close()).rejects.toBe(failure);
  expect(first).toHaveBeenCalledOnce();
  for (const owner of [collaboration, background, titles, notifications])
    expect(owner).toHaveBeenCalledOnce();
});

test("a late child result is durable while the parent's current run is cancelled", async () => {
  const { runtime, ports } = await fixture();
  vi.spyOn(ports.sessions, "active").mockReturnValue({
    runId: "cancelled-run",
    done: Promise.resolve(),
    aborted: true,
  });
  await runtime.inbox.deliver({
    parentSessionId: "owner",
    agentId: "child",
    agentType: "Explore",
    description: "Late findings",
    status: "completed",
    result: "Retain for the next interaction",
  });
  expect(ports.storage.setRuntime).toHaveBeenCalledWith(
    "owner",
    "subagent_inbox",
    "inbox",
    [expect.objectContaining({ text: expect.stringContaining("Retain for the next interaction") })],
    "queued",
  );
  expect(ports.sessions.run).not.toHaveBeenCalled();
});

test("child settlement retains the host's durable-storage diagnostic after publication fails", async () => {
  const { runtime } = await fixture();
  vi.spyOn(runtime.collaboration, "taskForChild").mockReturnValue({
    agentId: "agent",
    childSessionId: "child",
    parentSessionId: "owner",
    parentToolCallId: "tool",
    agentType: "Explore",
    description: "Explore",
    color: "blue",
    background: true,
    status: "running",
    startedAt: 1,
    modelLabel: "model",
    totalToolUseCount: 0,
    totalTokens: 0,
  });
  const failure = new Error("publication failed");
  const update = vi
    .spyOn(runtime.collaboration, "update")
    .mockImplementationOnce(() => {
      throw failure;
    })
    .mockImplementation(() => {});
  const report = vi.fn(() => "storage: publication failed");
  runtime.settle(
    "child",
    { runId: "run", done: Promise.resolve() },
    { status: "completed", endedAt: 2, result: "Findings" },
    report,
  );
  expect(report).toHaveBeenCalledWith(failure, "subagent.persist");
  expect(update).toHaveBeenLastCalledWith(
    "agent",
    expect.objectContaining({ status: "error", error: "storage: publication failed" }),
  );
});

test("builtin implementation graph has no desktop, UI or cross-package relative imports", async () => {
  const source = fileURLToPath(new URL("../src/", import.meta.url));
  const files = (await readdir(source, { recursive: true })).filter((name) => name.endsWith(".ts"));
  for (const name of files) {
    const file = join(source, name);
    const content = await readFile(file, "utf8");
    for (const match of content.matchAll(/(?:from\s*|import\s*\()?["']([^"'\n]+)["']/g)) {
      const specifier = match[1];
      if (!specifier.endsWith(".ts") && !specifier.startsWith("zpi-") && specifier !== "electron") continue;
      expect(specifier, `${name}: ${specifier}`).not.toMatch(/^(?:zpi-desktop|zpi-ui|electron)(?:\/|$)/);
      if (specifier.startsWith("."))
        expect(relative(source, resolve(dirname(file), specifier)), `${name}: ${specifier}`).not.toMatch(
          /^\.\.(?:\/|$)/,
        );
    }
  }
});
