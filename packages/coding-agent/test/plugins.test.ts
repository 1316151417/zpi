import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { builtinPlugins } from "@zpi-dev/builtin-plugins";
import { Type } from "typebox";
import { expect, test } from "vitest";
import { chunk, done, send } from "../../../tests/fake-server.ts";
import {
  assembleSession,
  type HookExecution,
  type HookInput,
  listCommands,
  parseInput,
  type SessionPlugin,
} from "../src/index.ts";
import { fixture } from "./helpers/resource-fixture.ts";

const answer: Parameters<typeof fixture>[0] = (_, response) => {
  send(response, chunk({ content: "finished" }));
  done(response);
};
function toolResponse(name: string, args: unknown): Parameters<typeof fixture>[0] {
  return (_, response, index) => {
    if (index === 0) {
      send(
        response,
        chunk({
          tool_calls: [
            {
              index: 0,
              id: "plugin-call",
              type: "function",
              function: { name, arguments: JSON.stringify(args) },
            },
          ],
        }),
      );
      done(response, "tool_calls");
    } else answer(_, response, index);
  };
}
const plugin = (extra: Partial<SessionPlugin>): SessionPlugin => ({
  id: "test.lifecycle",
  version: "1",
  ...extra,
});

test("assembly lists plugin commands and instructions without executing hooks and rejects conflicts", () => {
  let calls = 0;
  const assembly = assembleSession({
    builtinTools: [],
    plugins: [
      ...builtinPlugins,
      plugin({
        hooks: [
          {
            event: "SessionStart",
            handler: () => {
              calls++;
            },
          },
        ],
      }),
    ],
  });
  expect(calls).toBe(0);
  expect(assembly.instructions.join("\n")).toContain("Before the first tool call");
  expect(listCommands(assembly.commands).map((command) => command.name)).toEqual(["init", "compact"]);
  expect(listCommands().map((command) => command.name)).toEqual(["compact"]);
  expect(parseInput("/init")).toEqual({ kind: "prompt", text: "/init" });
  expect(() => assembleSession({ builtinTools: [], plugins: [plugin({}), plugin({})] })).toThrow(
    "Duplicate plugin",
  );
  expect(() =>
    assembleSession({
      builtinTools: [],
      plugins: [plugin({ commands: [{ name: "compact", description: "", prompt: "" }] })],
    }),
  ).toThrow("Invalid plugin command");
  expect(() =>
    assembleSession({
      builtinTools: [],
      plugins: [plugin({ commands: [{ name: "init", description: "", prompt: "" }] }), ...builtinPlugins],
    }),
  ).toThrow("Duplicate plugin command");
});

test("SDK hooks enrich context, replace tool input in order, and preserve a successful mutation after post hook failure", async () => {
  const seen: HookInput[] = [];
  const events: HookExecution[] = [];
  const f = await fixture(toolResponse("write", { path: "original.txt", content: "value" }), {
    plugins: [
      plugin({
        hooks: [
          {
            event: "SessionStart",
            handler: (input) => {
              seen.push(input);
              return { additionalContext: "startup context" };
            },
          },
          {
            event: "UserPromptSubmit",
            handler: (input) => {
              seen.push(input);
              return { additionalContext: "input context" };
            },
          },
          {
            event: "PreToolUse",
            matcher: "^write$",
            handler: (input) => {
              seen.push(input);
              return {
                updatedInput: { path: "redirected.txt", content: "new value" },
                additionalContext: "pre context",
              };
            },
          },
          {
            event: "PreToolUse",
            handler: (input) => {
              seen.push(input);
            },
          },
          {
            event: "PostToolUse",
            handler: (input) => {
              seen.push(input);
              throw new Error("post diagnostic");
            },
          },
        ],
      }),
    ],
  });
  f.session.subscribe((event) => {
    if (event.type === "hook_execution") events.push(event.execution);
  });
  await f.session.prompt("original user request");
  expect(await readFile(join(f.cwd, "redirected.txt"), "utf8")).toBe("new value");
  await expect(access(join(f.cwd, "original.txt"))).rejects.toThrow();
  expect(seen.filter((input) => input.event === "PreToolUse")[1]).toMatchObject({
    toolInput: { path: "redirected.txt" },
  });
  expect(seen.find((input) => input.event === "PostToolUse")).toMatchObject({
    toolInput: { path: "redirected.txt" },
    toolResult: { content: [{ type: "text", text: "Successfully wrote to redirected.txt" }] },
  });
  expect(JSON.stringify(f.server.requests[0].messages)).toContain("startup context");
  expect(JSON.stringify(f.server.requests[0].messages)).toContain("original user request");
  expect(JSON.stringify(f.server.requests[1].messages)).toContain("pre context");
  const result = f.session.messages.find((message) => message.role === "toolResult");
  expect(result).toMatchObject({
    role: "toolResult",
    isError: false,
    details: { fileChange: { path: join(f.cwd, "redirected.txt") } },
  });
  expect(events.find((event) => event.event === "PostToolUse")).toMatchObject({
    status: "error",
    pluginId: "test.lifecycle",
  });
});

test.each(["invalid", "deny"])(
  "%s pre hook never executes the original or replacement tool",
  async (mode) => {
    const f = await fixture(toolResponse("write", { path: "original.txt", content: "value" }), {
      hooks: [
        {
          event: "PreToolUse",
          handler: () =>
            mode === "invalid" ? { updatedInput: { path: 42 } } : { block: true, reason: "policy rejected" },
        },
        { event: "PreToolUse", handler: () => ({ updatedInput: { path: "other.txt", content: "other" } }) },
      ],
    });
    await f.session.prompt("try write");
    for (const path of ["original.txt", "other.txt"])
      await expect(access(join(f.cwd, path))).rejects.toThrow();
    expect(f.session.messages.filter((message) => message.role === "toolResult")).toHaveLength(1);
    expect(f.session.messages.find((message) => message.role === "toolResult")).toMatchObject({
      isError: true,
    });
  },
);

test("failed tool invokes failure hook and carries recovery context into the next model request", async () => {
  const seen: HookInput[] = [];
  const f = await fixture(toolResponse("read", { path: "missing.txt" }), {
    hooks: [
      {
        event: "PostToolUseFailure",
        handler: (input) => {
          seen.push(input);
          return { additionalContext: "try a different file" };
        },
      },
    ],
  });
  await f.session.prompt("read");
  expect(seen).toHaveLength(1);
  expect(seen[0]).toMatchObject({ event: "PostToolUseFailure", toolResult: { isError: true } });
  expect(JSON.stringify(f.server.requests[1].messages)).toContain("try a different file");
});

test("blocked user input never reaches history or model; startup context survives retry without rerunning startup", async () => {
  let startups = 0;
  const f = await fixture(answer, {
    hooks: [
      {
        event: "SessionStart",
        handler: () => {
          startups++;
          return { additionalContext: "startup retained" };
        },
      },
      {
        event: "UserPromptSubmit",
        handler: (input) =>
          input.event === "UserPromptSubmit" && input.prompt === "blocked"
            ? { block: true, reason: "blocked input" }
            : undefined,
      },
    ],
  });
  await expect(f.session.prompt("blocked")).rejects.toThrow("blocked input");
  expect(f.server.requests).toHaveLength(0);
  expect(f.session.messages.some((message) => message.role === "user")).toBe(false);
  await f.session.prompt("accepted");
  expect(startups).toBe(1);
  expect(JSON.stringify(f.server.requests[0].messages)).toContain("startup retained");
});

test("Stop feedback continues normal final answers at most three times", async () => {
  const active: boolean[] = [];
  const f = await fixture(answer, {
    hooks: [
      {
        event: "Stop",
        handler: (input) => {
          if (input.event === "Stop") active.push(input.stopHookActive);
          return { additionalContext: "verify before finishing" };
        },
      },
    ],
  });
  await f.session.prompt("finish");
  expect(f.server.requests).toHaveLength(4);
  expect(active).toEqual([false, true, true]);
  expect(JSON.stringify(f.server.requests[1].messages)).toContain("verify before finishing");
  expect((f.server.requests[1].messages as { role: string }[]).at(-1)?.role).toBe("user");
});

test("plugin tools use the SDK tool context and share selection and conflict rules", async () => {
  let cwd: string | undefined;
  const tool = {
    name: "plugin_echo",
    label: "Echo",
    description: "Echo plugin input",
    parameters: Type.Object({ text: Type.String() }),
    execute: async (
      _id: string,
      args: { text: string },
      _signal: AbortSignal | undefined,
      _update: unknown,
      context: import("@zpi-dev/coding-agent").ToolContext,
    ) => {
      cwd = context.cwd;
      return { content: [{ type: "text" as const, text: args.text }], details: undefined };
    },
  };
  const f = await fixture(toolResponse("plugin_echo", { text: "plugin response" }), {
    plugins: [plugin({ tools: [tool] })],
  });
  await f.session.prompt("echo");
  expect(cwd).toBe(f.cwd);
  expect(JSON.stringify(f.server.requests[1].messages)).toContain("plugin response");
  expect(
    assembleSession({
      builtinTools: [],
      plugins: [plugin({ tools: [tool] })],
      noTools: "builtin",
    }).activeTools.map((t) => t.name),
  ).toEqual(["plugin_echo"]);
  expect(() =>
    assembleSession({ builtinTools: [], customTools: [tool], plugins: [plugin({ tools: [tool] })] }),
  ).toThrow("Duplicate tool names");
});

test("plugin tool overrides execute through the SDK and retain explicit conflict rules", async () => {
  let calls = 0;
  const override = {
    name: "bash",
    label: "Plugin bash",
    description: "Plugin-controlled command",
    parameters: Type.Object({ command: Type.String() }),
    execute: async () => {
      calls++;
      return { content: [{ type: "text" as const, text: "plugin command result" }], details: undefined };
    },
  };
  const f = await fixture(toolResponse("bash", { command: "touch unexpected.txt" }), {
    plugins: [plugin({ toolOverrides: [override] })],
  });
  await f.session.prompt("run command");
  expect(calls).toBe(1);
  expect(JSON.stringify(f.server.requests[1].messages)).toContain("plugin command result");
  await expect(access(join(f.cwd, "unexpected.txt"))).rejects.toThrow();
  expect(() =>
    assembleSession({ builtinTools: [], plugins: [plugin({ toolOverrides: [override] })] }),
  ).toThrow("Unknown built-in tool override");
  expect(() =>
    assembleSession({
      builtinTools: [override],
      toolOverrides: [override],
      plugins: [plugin({ toolOverrides: [override] })],
    }),
  ).toThrow("Duplicate tool overrides");
});

test("prompt hooks prepare dynamic plugin instructions before each model request; assembly stays lazy", async () => {
  let revision = 0;
  let evaluations = 0;
  const contribution = plugin({
    contextInstructions: () => {
      evaluations++;
      return [`prepared context revision ${revision}`];
    },
    hooks: [
      {
        event: "UserPromptSubmit",
        handler: () => {
          revision++;
        },
      },
    ],
  });
  assembleSession({ builtinTools: [], plugins: [contribution] });
  expect(evaluations).toBe(0);
  const f = await fixture(answer, { plugins: [contribution] });
  await f.session.prompt("first turn");
  expect(JSON.stringify(f.server.requests[0].messages)).toContain("prepared context revision 1");
  await f.session.prompt("second turn");
  expect(JSON.stringify(f.server.requests[1].messages)).toContain("prepared context revision 2");
});

test("a blocking verdict survives oversized additional context", async () => {
  const f = await fixture(toolResponse("write", { path: "denied.txt", content: "value" }), {
    hooks: [
      {
        event: "PreToolUse",
        handler: () => ({ block: true, reason: "denied", additionalContext: "x".repeat(24_001) }),
      },
    ],
  });
  await f.session.prompt("write");
  await expect(access(join(f.cwd, "denied.txt"))).rejects.toThrow();
  expect(f.session.messages.find((m) => m.role === "toolResult")).toMatchObject({ isError: true });
});

test("PreToolUse timeout obeys block policy and reports a timeout", async () => {
  const events: HookExecution[] = [];
  const f = await fixture(toolResponse("write", { path: "blocked.txt", content: "value" }), {
    hooks: [{ event: "PreToolUse", timeoutMs: 10, onError: "block", handler: () => new Promise(() => {}) }],
  });
  f.session.subscribe((event) => {
    if (event.type === "hook_execution") events.push(event.execution);
  });
  await f.session.prompt("write");
  await expect(access(join(f.cwd, "blocked.txt"))).rejects.toThrow();
  expect(events.find((event) => event.event === "PreToolUse")?.status).toBe("timeout");
});

test("cancelling an awaiting post hook preserves completed tool results and snapshots", async () => {
  let entered!: () => void;
  const waiting = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const f = await fixture(toolResponse("write", { path: "completed.txt", content: "value" }), {
    hooks: [
      {
        event: "PostToolUse",
        handler: () => {
          entered();
          return new Promise(() => {});
        },
      },
    ],
  });
  const run = f.session.prompt("write");
  await waiting;
  await f.session.abort();
  await run;
  expect(await readFile(join(f.cwd, "completed.txt"), "utf8")).toBe("value");
  expect(f.session.messages.find((message) => message.role === "toolResult")).toMatchObject({
    isError: false,
    details: { fileChange: { path: join(f.cwd, "completed.txt") } },
  });
  expect(f.server.requests).toHaveLength(1);
});
