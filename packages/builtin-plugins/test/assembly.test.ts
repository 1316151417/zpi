import { Type } from "typebox";
import { expect, test, vi } from "vitest";
import { builtinPluginHooks, desktopPluginIds, desktopPluginManifests } from "zpi-builtin-plugins";
import {
  type BuiltinPluginBindings,
  pluginsForSubagent,
  resolveBuiltinPlugins,
} from "zpi-builtin-plugins/assembly";
import type { TaskBackend } from "zpi-builtin-plugins/tasks/controls";
import {
  assembleSession,
  createCodingTools,
  type SessionPlugin,
  type ToolDefinition,
} from "zpi-coding-agent";
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
      prepare: async () => {},
      instructions: () => [],
      read: () => {},
      schedule: () => {},
      settled: () => {},
    },
    titles: { fallback: () => {}, start: () => {} },
    notifications: { send: () => {} },
    questionTool: vi.fn(() => tool("AskUserQuestion")),
    webTools: vi.fn(() => [tool("WebSearch"), tool("WebFetch")]),
    background: { tool: vi.fn(() => tool("bash")), taskBackend: () => backend("bash") },
    collaboration: {
      tools: vi.fn(() => [tool("Agent"), tool("SendMessage")]),
      childTools: vi.fn(() => [tool("RespondToCoordinator")]),
      prepare: vi.fn(),
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

test("preview and assembly do not prepare agent runs; collaboration owns preparation and dynamic context", async () => {
  const port = ports();
  const contributions = resolve([desktopPluginIds.collaboration], port);
  const assembly = assembleSession({ ...contributions, builtinTools: [] });
  expect(assembly.getInstructions().join("\n")).toContain("preview agents");
  expect(port.collaboration.prepare).not.toHaveBeenCalled();
  const hook = (contributions.plugins as SessionPlugin[])[0].hooks?.[0];
  if (!hook) throw new Error("Missing collaboration hook");
  await hook.handler(
    { event: "UserPromptSubmit", sessionId: "owner", cwd: "/tmp", invocationId: "turn", prompt: "delegate" },
    new AbortController().signal,
  );
  expect(port.collaboration.prepare).toHaveBeenCalledWith("owner", false);
  expect(port.webTools).not.toHaveBeenCalled();
  expect(port.questionTool).not.toHaveBeenCalled();
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
