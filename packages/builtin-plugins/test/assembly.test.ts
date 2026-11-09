import { builtinPluginHooks, desktopPluginIds, desktopPluginManifests } from "@zpi-dev/builtin-plugins";
import {
  type BuiltinPluginBindings,
  pluginsForSubagent,
  resolveBuiltinPlugins,
} from "@zpi-dev/builtin-plugins/assembly";
import type { TaskBackend } from "@zpi-dev/builtin-plugins/tasks/controls";
import { assembleSession, createCodingTools, type ToolDefinition } from "@zpi-dev/coding-agent";
import { Type } from "typebox";
import { expect, test, vi } from "vitest";
import type { SubagentProfile } from "../src/collaboration/types.ts";

function tool(name: string): ToolDefinition {
  return {
    name,
    label: name,
    description: name,
    parameters: Type.Object({}),
    execute: async () => ({ content: [], details: undefined }),
  };
}
function backend(kind: string): TaskBackend {
  return {
    kind,
    owns: () => false,
    output: async () => ({ content: [], details: undefined }),
    stop: async () => ({ content: [], details: undefined }),
  };
}
function ports(): BuiltinPluginBindings {
  return {
    memory: {
      beginTurn: vi.fn(),
      instructions: () => [],
      read: () => {},
      schedule: vi.fn(),
    },
    titles: { fallback: () => {}, start: () => {} },
    notifications: { send: () => {} },
    questionTool: vi.fn(() => tool("AskUserQuestion")),
    webTools: vi.fn(() => [tool("WebSearch"), tool("WebFetch")]),
    background: { tool: vi.fn(() => tool("bash")), taskBackend: () => backend("bash") },
    collaboration: {
      tools: vi.fn(() => [tool("Agent"), tool("SendMessage")]),
      childTools: vi.fn(() => [tool("RespondToCoordinator")]),
      listing: () => "live agents",
      previewListing: () => "preview agents",
      taskBackend: () => backend("agent"),
    },
  };
}
function resolve(ids: string[], port = ports()) {
  return resolveBuiltinPlugins(
    desktopPluginManifests.filter((p) => ids.includes(p.id)),
    { sessionId: "owner", cwd: "/tmp", preview: true },
    port,
  );
}

test("builtin hook settings are projected from the same declarations used by runtime binding", () => {
  const snapshots = desktopPluginManifests.map((snapshot) =>
    snapshot.id === desktopPluginIds.memory ? { ...snapshot, options: { mode: "long" } } : snapshot,
  );
  const plugins =
    resolveBuiltinPlugins(snapshots, { sessionId: "owner", cwd: "/tmp" }, ports()).plugins ?? [];
  for (const snapshot of snapshots) {
    expect(
      plugins
        .find((plugin) => plugin.id === snapshot.id)
        ?.hooks?.map(({ event, matcher, onError }) => ({ event, matcher, onError })) ?? [],
    ).toEqual(
      builtinPluginHooks(snapshot).map(({ event, matcher, onError }) => ({ event, matcher, onError })),
    );
  }
});

test.each([
  [[], []],
  [[desktopPluginIds.background], ["TaskOutput", "TaskStop"]],
  [[desktopPluginIds.collaboration], ["Agent", "SendMessage", "TaskOutput", "TaskStop"]],
  [
    [desktopPluginIds.background, desktopPluginIds.collaboration],
    ["Agent", "SendMessage", "TaskOutput", "TaskStop"],
  ],
])("background and collaboration independently register shared task controls once (%s)", (ids, extra) => {
  const contributions = resolve(ids);
  const assembly = assembleSession({ ...contributions, builtinTools: createCodingTools("/tmp") });
  expect(assembly.activeTools.map((t) => t.name)).toEqual(["read", "bash", "edit", "write", ...extra]);
  expect(contributions.plugins?.some((p) => p.toolOverrides?.length)).toBe(
    ids.includes(desktopPluginIds.background),
  );
});

test.each([true, false])(
  "collaboration consumes its catalog without a per-input preparation hook (preview=%s)",
  (preview) => {
    const port = ports();
    const snapshots = desktopPluginManifests.filter((plugin) => plugin.id === desktopPluginIds.collaboration);
    const contributions = resolveBuiltinPlugins(
      snapshots,
      { sessionId: "owner", cwd: "/tmp", preview },
      port,
    );
    const assembly = assembleSession({ ...contributions, builtinTools: [] });
    expect(Object.values(assembly.getContextSections()).join("\n")).toContain(
      preview ? "preview agents" : "live agents",
    );
    expect(contributions.plugins?.[0].hooks ?? []).toEqual([]);
    expect(builtinPluginHooks(snapshots[0])).toEqual([]);
    expect(port.webTools).not.toHaveBeenCalled();
    expect(port.questionTool).not.toHaveBeenCalled();
  },
);

test.each(["off", "short"])("%s memory has no per-input or run-end preparation hooks", (mode) => {
  const base = desktopPluginManifests.find((plugin) => plugin.id === desktopPluginIds.memory);
  if (!base) throw new Error("Missing memory plugin");
  const snapshot = { ...base, options: { mode } };
  expect(builtinPluginHooks(snapshot)).toEqual([]);
  const contributions = resolveBuiltinPlugins([snapshot], { sessionId: "owner", cwd: "/tmp" }, ports());
  expect(contributions.plugins?.[0].hooks ?? []).toEqual([]);
});

test("long memory begins usage tracking per turn and schedules generation once without a capture hook", async () => {
  const base = desktopPluginManifests.find((plugin) => plugin.id === desktopPluginIds.memory);
  if (!base) throw new Error("Missing memory plugin");
  const snapshot = { ...base, options: { mode: "long" } };
  const port = ports();
  const contributions = resolveBuiltinPlugins([snapshot], { sessionId: "owner", cwd: "/tmp" }, port);
  const hooks = contributions.plugins?.[0].hooks ?? [];
  expect(hooks.map((hook) => hook.event)).toEqual(["UserPromptSubmit", "PostToolUse"]);
  for (let turn = 0; turn < 2; turn++) {
    await hooks[0].handler(
      {
        event: "UserPromptSubmit",
        sessionId: "owner",
        cwd: "/tmp",
        invocationId: `turn-${turn}`,
        prompt: "continue",
      },
      new AbortController().signal,
    );
  }
  expect(port.memory.beginTurn).toHaveBeenCalledTimes(2);
  expect(port.memory.schedule).toHaveBeenCalledExactlyOnceWith("owner");
  const profile: SubagentProfile = {
    id: "child",
    name: "child",
    description: "Child",
    systemPrompt: "Work",
    color: "blue",
    scope: "built-in",
    enabled: true,
    injectAgentsMd: false,
  };
  expect(
    resolveBuiltinPlugins([snapshot], { sessionId: "child", cwd: "/tmp", profile }, port).plugins?.[0]
      .hooks ?? [],
  ).toEqual([]);
});

test("child plugins keep the coordinator channel and apply profile permissions without recursive agents", () => {
  const profile: SubagentProfile = {
    id: "test",
    name: "test",
    description: "test",
    systemPrompt: "test",
    color: "blue",
    scope: "built-in",
    enabled: true,
    injectAgentsMd: false,
    tools: ["bash"],
    disallowedTools: ["TaskStop"],
  };
  const children = pluginsForSubagent(desktopPluginManifests);
  const contributions = resolveBuiltinPlugins(
    children,
    { sessionId: "child", cwd: "/tmp", profile },
    ports(),
  );
  const assembly = assembleSession({ ...contributions, builtinTools: createCodingTools("/tmp") });
  expect(assembly.activeTools.map((t) => t.name)).toEqual(["bash", "TaskOutput", "RespondToCoordinator"]);
  expect(children.some((p) => p.id === desktopPluginIds.collaboration)).toBe(false);
  expect(children.some((p) => p.id === desktopPluginIds.coordinator)).toBe(true);
});
