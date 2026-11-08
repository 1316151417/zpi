import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentSession, SessionManager, StaticResourceLoader } from "@zpi-dev/coding-agent";
import { Type } from "typebox";
import { afterEach, expect, test, vi } from "vitest";
import { chunk, done, fakeServer, send } from "../../../tests/fake-server.ts";
import { forkSession, getSessionMessages, listSessions, query, renameSession } from "../src/index.ts";
import { runtimeFor } from "../src/runtime.ts";
import type { Options, SDKMessage, SDKResultMessage } from "../src/types.ts";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function fixture(reply = "Hello SDK") {
  const dir = await mkdtemp(join(tmpdir(), "zpi-agent-sdk-"));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const server = await fakeServer((_, response) => {
    send(response, chunk({ content: reply }));
    done(response);
  });
  cleanup.push(() => server.close());
  const options: Options = {
    cwd: dir,
    model: "test",
    tools: [],
    zpi: {
      agentDir: join(dir, "sdk"),
      providers: {
        local: {
          apiKey: "test-key",
          baseUrl: server.url,
          models: [
            {
              id: "test",
              name: "Test",
              input: ["text", "image"],
              reasoning: false,
              contextWindow: 128000,
              maxTokens: 8192,
              cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
            },
          ],
        },
      },
    },
  };
  return { dir, server, options };
}
async function collect(options: Options, prompt = "Hello"): Promise<SDKMessage[]> {
  const messages: SDKMessage[] = [];
  for await (const message of query({ prompt, options })) messages.push(message);
  return messages;
}
const result = (messages: SDKMessage[]) =>
  messages.findLast((message) => message.type === "result") as SDKResultMessage;

test("preset instructions reflect the final selected plugin tools", async () => {
  const f = await fixture();
  const tool = (name: string, rule: string) => ({
    name,
    label: name,
    description: name,
    parameters: Type.Object({}),
    promptGuidelines: [rule],
    execute: async () => ({ content: [{ type: "text" as const, text: "done" }], details: undefined }),
  });
  await collect({
    ...f.options,
    tools: ["Active"],
    systemPrompt: { type: "preset", preset: "claude_code" },
    zpi: {
      ...f.options.zpi,
      plugins: [
        {
          id: "tools",
          version: "1",
          tools: [tool("Active", "ACTIVE_PLUGIN_GUIDE"), tool("Hidden", "HIDDEN_PLUGIN_GUIDE")],
        },
      ],
    },
  });
  const prompt = JSON.stringify(f.server.requests[0].messages);
  expect(prompt).toContain("ACTIVE_PLUGIN_GUIDE");
  expect(prompt).not.toContain("HIDDEN_PLUGIN_GUIDE");
});

test("SDK prompt composition uses the core validation of dynamic plugin instructions", async () => {
  const f = await fixture();
  await expect(
    collect({
      ...f.options,
      zpi: {
        ...f.options.zpi,
        plugins: [{ id: "invalid", version: "1", contextInstructions: () => "invalid" as never }],
      },
    }),
  ).rejects.toThrow("Invalid plugin context instructions");
  expect(f.server.requests).toHaveLength(0);
});

test("host-owned queries reject a canUseTool callback instead of silently ignoring it", async () => {
  const f = await fixture();
  const runtime = await runtimeFor(f.options);
  const manager = SessionManager.inMemory(f.dir);
  const { session } = await createAgentSession({
    cwd: f.dir,
    agentDir: f.options.zpi?.agentDir,
    modelRuntime: runtime,
    sessionManager: manager,
    resourceLoader: new StaticResourceLoader(),
    noTools: "all",
  });
  cleanup.push(async () => {
    await session.abort();
    session.dispose();
  });
  const canUseTool = vi.fn(async () => ({ behavior: "deny" as const, message: "Denied" }));
  await expect(
    collect({
      canUseTool,
      zpi: { session, sessionManager: manager, modelRuntime: runtime },
    }),
  ).rejects.toThrow("Configure tool/loop policy when creating a host-owned SDK session");
  expect(canUseTool).not.toHaveBeenCalled();
  expect(f.server.requests).toHaveLength(0);
});

test("quickstart query uses canonical init, assistant, partial and result protocols", async () => {
  const f = await fixture();
  const messages = await collect({
    ...f.options,
    includePartialMessages: true,
    systemPrompt: "CUSTOM_SYSTEM",
  });
  expect(messages[0]).toMatchObject({
    type: "system",
    subtype: "init",
    model: "test",
    tools: [],
    mcp_servers: [],
  });
  expect(messages).toContainEqual(
    expect.objectContaining({
      type: "assistant",
      message: expect.objectContaining({ role: "assistant", content: [{ type: "text", text: "Hello SDK" }] }),
    }),
  );
  expect(
    messages.some(
      (message) => message.type === "stream_event" && message.event.type === "content_block_delta",
    ),
  ).toBe(true);
  expect(result(messages)).toMatchObject({
    type: "result",
    subtype: "success",
    result: "Hello SDK",
    num_turns: 1,
    is_error: false,
  });
  expect(f.server.requests[0].messages).toContainEqual({
    role: "system",
    content: expect.stringContaining("\n\nCUSTOM_SYSTEM"),
  });
});

test("streaming input preserves one session and yields one result for each input", async () => {
  const f = await fixture();
  async function* input() {
    for (const text of ["First", "Second"])
      yield {
        type: "user" as const,
        uuid: text,
        parent_tool_use_id: null,
        message: { role: "user" as const, content: text },
      };
  }
  const messages: SDKMessage[] = [];
  for await (const message of query({ prompt: input(), options: f.options })) messages.push(message);
  expect(messages.filter((message) => message.type === "result")).toHaveLength(2);
  expect(new Set(messages.map((message) => message.session_id))).toHaveProperty("size", 1);
  expect(messages.filter((message) => message.type === "user").map((message) => message.uuid)).toEqual([
    "First",
    "Second",
  ]);
  expect(JSON.stringify(f.server.requests[1].messages)).toContain("First");
});

test("resume, fork, listing and rename retain session messages", async () => {
  const f = await fixture();
  const original = result(await collect(f.options, "Persisted first turn"));
  await collect({ ...f.options, resume: original.session_id }, "Second turn");
  const listed = await listSessions({ zpi: f.options.zpi });
  expect(listed).toHaveLength(1);
  const history = await getSessionMessages(original.session_id, { zpi: f.options.zpi });
  expect(history.filter((message) => message.type === "user")).toHaveLength(2);
  await renameSession(original.session_id, "SDK title", { zpi: f.options.zpi });
  expect((await listSessions({ zpi: f.options.zpi }))[0].summary).toBe("SDK title");
  const fork = await forkSession(original.session_id, { zpi: f.options.zpi, upToMessageId: history[1].uuid });
  await collect({ ...f.options, resume: fork.sessionId }, "Fork continuation");
  expect(
    (await getSessionMessages(original.session_id, { zpi: f.options.zpi })).filter(
      (message) => message.type === "user",
    ),
  ).toHaveLength(2);
});

test("canonical Read and Edit parameters execute a real file edit", async () => {
  const f = await fixture();
  await writeFile(join(f.dir, "sample.txt"), "before\n");
  const responses = [
    { name: "Read", arguments: { file_path: "sample.txt" } },
    { name: "Edit", arguments: { file_path: "sample.txt", old_string: "before", new_string: "after" } },
  ];
  const server = await fakeServer((_, response) => {
    const call = responses.shift();
    if (call) {
      send(
        response,
        chunk({
          tool_calls: [
            {
              index: 0,
              id: `call_${responses.length}`,
              type: "function",
              function: { name: call.name, arguments: JSON.stringify(call.arguments) },
            },
          ],
        }),
      );
      done(response, "tool_calls");
    } else {
      send(response, chunk({ content: "Edited" }));
      done(response);
    }
  });
  cleanup.push(() => server.close());
  const options = structuredOptions(f.options, server.url);
  const permit = vi.fn(async () => ({ behavior: "deny" as const, message: "Not approved" }));
  const messages = await collect({
    ...options,
    tools: ["Read", "Edit"],
    allowedTools: ["Read", "Edit"],
    canUseTool: permit,
    enableFileCheckpointing: true,
  });
  expect(permit).not.toHaveBeenCalled();
  expect(result(messages).subtype).toBe("success");
  expect(await readFile(join(f.dir, "sample.txt"), "utf8")).toBe("after\n");
  const user = messages.find((message) => message.type === "user");
  expect(user?.uuid).toBeTruthy();
});
function structuredOptions(options: Options, url: string): Options {
  return {
    ...options,
    zpi: { ...options.zpi, providers: { local: { ...options.zpi?.providers?.local, baseUrl: url } } },
  };
}

test("allowedTools does not hide other tools, qualified denies win and callbacks receive canonical inputs", async () => {
  const f = await fixture();
  const approval = vi.fn(async () => ({ behavior: "deny" as const, message: "Review required" }));
  let requested = false;
  const server = await fakeServer((_, response) => {
    if (!requested) {
      requested = true;
      send(
        response,
        chunk({
          tool_calls: [
            {
              index: 0,
              id: "danger",
              type: "function",
              function: { name: "Bash", arguments: '{"command":"echo denied"}' },
            },
          ],
        }),
      );
      done(response, "tool_calls");
    } else {
      send(response, chunk({ content: "Denied safely" }));
      done(response);
    }
  });
  cleanup.push(() => server.close());
  const messages = await collect({
    ...structuredOptions(f.options, server.url),
    tools: ["Read", "Bash"],
    allowedTools: ["Read"],
    disallowedTools: ["Bash(echo *)"],
    canUseTool: approval,
  });
  const init = messages[0];
  expect(init.type === "system" && init.subtype === "init" && init.tools).toEqual(["Read", "Bash"]);
  expect(approval).not.toHaveBeenCalled();
  expect(result(messages).permission_denials).toHaveLength(1);
});

test("maxTurns stops the actual model loop before another provider request", async () => {
  const f = await fixture();
  const server = await fakeServer((_, response) => {
    send(
      response,
      chunk({
        tool_calls: [
          {
            index: 0,
            id: `call_${Date.now()}`,
            type: "function",
            function: { name: "Bash", arguments: '{"command":"true"}' },
          },
        ],
      }),
    );
    done(response, "tool_calls");
  });
  cleanup.push(() => server.close());
  const messages = await collect({
    ...structuredOptions(f.options, server.url),
    tools: ["Bash"],
    maxTurns: 1,
  });
  expect(server.requests).toHaveLength(1);
  expect(result(messages)).toMatchObject({ subtype: "error_max_turns", num_turns: 1, is_error: true });
});

test("hooks use canonical callbacks, snake_case payloads, input replacement and added context", async () => {
  const f = await fixture();
  const hook = vi.fn(async () => ({
    hookSpecificOutput: { hookEventName: "UserPromptSubmit" as const, additionalContext: "SDK_HOOK_CONTEXT" },
  }));
  const end = vi.fn(async () => ({}));
  await collect({
    ...f.options,
    hooks: { UserPromptSubmit: [{ hooks: [hook] }], SessionEnd: [{ hooks: [end] }] },
  });
  expect(hook).toHaveBeenCalledWith(
    expect.objectContaining({
      hook_event_name: "UserPromptSubmit",
      session_id: expect.any(String),
      prompt: "Hello",
    }),
    undefined,
    expect.objectContaining({ signal: expect.any(AbortSignal) }),
  );
  expect(JSON.stringify(f.server.requests[0].messages)).toContain("SDK_HOOK_CONTEXT");
  expect(end).toHaveBeenCalledOnce();
});

test("structured output is validated against the requested schema", async () => {
  const f = await fixture('{"translated":"你好"}');
  const messages = await collect({
    ...f.options,
    outputFormat: {
      type: "json_schema",
      schema: {
        type: "object",
        properties: { translated: { type: "string" } },
        required: ["translated"],
        additionalProperties: false,
      },
    },
  });
  expect(result(messages)).toMatchObject({ subtype: "success", structured_output: { translated: "你好" } });
});

test("unsupported surface areas fail explicitly", () => {
  expect(() => query({ prompt: "test", options: { permissionMode: "acceptEdits" } as never })).toThrow(
    "permissionMode",
  );
});

test("initialization can be closed without starting a model request", async () => {
  const f = await fixture();
  const end = vi.fn(async () => ({}));
  const response = query({
    prompt: "Not sent",
    options: { ...f.options, hooks: { SessionEnd: [{ hooks: [end] }] } },
  });
  expect((await response.initializationResult()).models).toContainEqual(
    expect.objectContaining({ value: "local/test" }),
  );
  await response.return();
  expect(f.server.requests).toHaveLength(0);
  expect(end).toHaveBeenCalledOnce();
});

test("invalid structured output is bounded and reported", async () => {
  const f = await fixture("This is not JSON");
  const messages = await collect({
    ...f.options,
    outputFormat: { type: "json_schema", schema: { type: "object" } },
  });
  expect(result(messages)).toMatchObject({ subtype: "error_max_structured_output_retries", is_error: true });
  expect(f.server.requests).toHaveLength(3);
});

test("SDK canUseTool replaces input before execution and tool schemas revalidate it", async () => {
  const f = await fixture();
  let requested = false;
  const server = await fakeServer((_, response) => {
    if (!requested) {
      requested = true;
      send(
        response,
        chunk({
          tool_calls: [
            {
              index: 0,
              id: "rewrite",
              type: "function",
              function: { name: "Bash", arguments: '{"command":"echo ORIGINAL"}' },
            },
          ],
        }),
      );
      done(response, "tool_calls");
    } else {
      send(response, chunk({ content: "Done" }));
      done(response);
    }
  });
  cleanup.push(() => server.close());
  const callback = vi.fn(async () => ({
    behavior: "allow" as const,
    updatedInput: { command: "printf REWRITTEN" },
  }));
  const messages = await collect({
    ...structuredOptions(f.options, server.url),
    tools: ["Bash"],
    canUseTool: callback,
  });
  expect(callback).toHaveBeenCalledWith(
    "Bash",
    { command: "echo ORIGINAL" },
    expect.objectContaining({ toolUseID: "rewrite", signal: expect.any(AbortSignal) }),
  );
  expect(
    messages
      .filter((message) => message.type === "user" && Array.isArray(message.message.content))
      .some((message) => JSON.stringify(message).includes("REWRITTEN")),
  ).toBe(true);
});

test("a configured agent executes a real isolated child query", async () => {
  const f = await fixture();
  const server = await fakeServer((body, response) => {
    const names =
      (body.tools as { function: { name: string } }[] | undefined)?.map((tool) => tool.function.name) ?? [];
    const hasTool = (body.messages as { role: string }[]).some((message) => message.role === "tool");
    if (names.includes("Agent") && !hasTool) {
      send(
        response,
        chunk({
          tool_calls: [
            {
              index: 0,
              id: "child",
              type: "function",
              function: {
                name: "Agent",
                arguments: JSON.stringify({
                  description: "Delegate",
                  subagent_type: "translator",
                  prompt: "Translate hello",
                }),
              },
            },
          ],
        }),
      );
      done(response, "tool_calls");
    } else {
      send(response, chunk({ content: names.includes("Agent") ? "Parent done" : "Child translated" }));
      done(response);
    }
  });
  cleanup.push(() => server.close());
  const messages = await collect({
    ...structuredOptions(f.options, server.url),
    tools: ["Agent"],
    agents: { translator: { description: "Translate", prompt: "Translate only", tools: [] } },
  });
  expect(result(messages)).toMatchObject({ subtype: "success", result: "Parent done" });
  expect(server.requests.some((request) => JSON.stringify(request.messages).includes("Translate only"))).toBe(
    true,
  );
});

test("tools can be denied and file checkpoints restore changes without touching external edits", async () => {
  const f = await fixture();
  await writeFile(join(f.dir, "checkpoint.txt"), "original");
  let requested = false;
  const server = await fakeServer((_, response) => {
    if (!requested) {
      requested = true;
      send(
        response,
        chunk({
          tool_calls: [
            {
              index: 0,
              id: "write",
              type: "function",
              function: { name: "Write", arguments: '{"file_path":"checkpoint.txt","content":"updated"}' },
            },
          ],
        }),
      );
      done(response, "tool_calls");
    } else {
      send(response, chunk({ content: "Done" }));
      done(response);
    }
  });
  cleanup.push(() => server.close());
  const response = query({
    prompt: "Change the file",
    options: { ...structuredOptions(f.options, server.url), tools: ["Write"], enableFileCheckpointing: true },
  });
  let userId = "";
  while (true) {
    const next = await response.next();
    if (next.done) break;
    if (next.value.type === "user" && !userId) userId = next.value.uuid ?? "";
    if (next.value.type === "result") break;
  }
  expect(await response.rewindFiles(userId, { dryRun: true })).toMatchObject({
    canRewind: true,
    filesChanged: [join(f.dir, "checkpoint.txt")],
  });
  await response.rewindFiles(userId);
  expect(await readFile(join(f.dir, "checkpoint.txt"), "utf8")).toBe("original");
  await response.return();
});

test("local plugins expose canonical commands, skills and Agent definitions", async () => {
  const f = await fixture();
  const plugin = join(f.dir, "plugin");
  await mkdir(join(plugin, ".claude-plugin"), { recursive: true });
  await mkdir(join(plugin, "agents"));
  await mkdir(join(plugin, "commands"));
  await mkdir(join(plugin, "skills", "translate"), { recursive: true });
  await writeFile(
    join(plugin, ".claude-plugin", "plugin.json"),
    JSON.stringify({
      name: "sample",
      version: "1.0",
      hooks: {
        UserPromptSubmit: [
          {
            hooks: [
              {
                type: "process",
                command: process.execPath,
                args: [
                  "-e",
                  'console.log(JSON.stringify({hookSpecificOutput:{hookEventName:"UserPromptSubmit",additionalContext:process.env.SDK_PLUGIN_ENV}}))',
                ],
              },
            ],
          },
        ],
      },
    }),
  );
  await writeFile(
    join(plugin, "agents", "translator.md"),
    "---\nname: translator\ndescription: Translate text\ntools: Read, Grep\n---\nTranslate carefully.",
  );
  await writeFile(
    join(plugin, "commands", "greet.md"),
    "---\ndescription: Greet\n---\nPLUGIN_GREETING $ARGUMENTS",
  );
  await writeFile(
    join(plugin, "skills", "translate", "SKILL.md"),
    "---\nname: translate\ndescription: Translation skill\n---\nTranslate faithfully.",
  );
  const response = query({
    prompt: "/sample:greet hello",
    options: {
      ...f.options,
      env: { SDK_PLUGIN_ENV: "SDK_PLUGIN_ENV_OK" },
      plugins: [{ type: "local", path: plugin }],
    },
  });
  expect((await response.supportedAgents()).map((agent) => agent.name)).toContain("sample:translator");
  expect((await response.supportedCommands()).map((command) => command.name)).toContain("sample:greet");
  const messages: SDKMessage[] = [];
  for await (const message of response) messages.push(message);
  expect(result(messages).subtype).toBe("success");
  expect(JSON.stringify(f.server.requests[0].messages)).toContain("PLUGIN_GREETING hello");
  expect(JSON.stringify(f.server.requests[0].messages)).toContain("SDK_PLUGIN_ENV_OK");
});

test("bare denied tools are absent from the model context", async () => {
  const f = await fixture();
  const messages = await collect({ ...f.options, tools: ["Read", "Bash"], disallowedTools: ["Bash"] });
  expect(messages[0]).toMatchObject({ tools: ["Read"] });
});

test("concurrent next calls preserve AsyncGenerator ordering and close interrupts pending input", async () => {
  const f = await fixture();
  const response = query({ prompt: "hello", options: f.options });
  const [first, second] = await Promise.all([response.next(), response.next()]);
  expect(first.value).toMatchObject({ type: "system", subtype: "init" });
  expect(second.value).toMatchObject({ type: "user" });
  await response.return();
  expect(await response.next()).toEqual({ done: true, value: undefined });
});

test("maxBudgetUsd uses priced token usage to stop the next model request", async () => {
  const f = await fixture();
  const server = await fakeServer((_, response) => {
    send(
      response,
      chunk({
        tool_calls: [
          {
            index: 0,
            id: "budget",
            type: "function",
            function: { name: "Bash", arguments: '{"command":"true"}' },
          },
        ],
      }),
    );
    send(response, {
      ...chunk({}, "tool_calls"),
      usage: { prompt_tokens: 1000, completion_tokens: 100, total_tokens: 1100 },
    });
    response.end("data: [DONE]\n\n");
  });
  cleanup.push(() => server.close());
  const messages = await collect({
    ...structuredOptions(f.options, server.url),
    tools: ["Bash"],
    maxBudgetUsd: 0.0001,
  });
  expect(server.requests).toHaveLength(1);
  expect(result(messages)).toMatchObject({
    subtype: "error_max_budget_usd",
    is_error: true,
    usage: { input_tokens: 1000, output_tokens: 100 },
  });
});

test("interrupt aborts a live request and returns an error result without leaking the stream", async () => {
  const f = await fixture();
  const server = await fakeServer((_, response) => {
    send(response, chunk({ content: "Started" }));
  });
  cleanup.push(() => server.close());
  const response = query({
    prompt: "hello",
    options: { ...structuredOptions(f.options, server.url), includePartialMessages: true },
  });
  let interrupted = false,
    final: SDKResultMessage | undefined;
  for await (const message of response) {
    if (!interrupted && message.type === "stream_event" && message.event.type === "content_block_delta") {
      interrupted = true;
      await response.interrupt();
    }
    if (message.type === "result") final = message;
  }
  expect(interrupted).toBe(true);
  expect(final).toMatchObject({ subtype: "error_during_execution", is_error: true });
});

test("one resource catalog serves initialization, Skill execution and later reloads", async () => {
  const f = await fixture();
  let revision = 0;
  const reload = vi.fn(async () => {
    revision++;
  });
  const server = await fakeServer((body, response) => {
    const messages = body.messages as { role: string }[];
    if (!messages.some((message) => message.role === "tool")) {
      send(
        response,
        chunk({
          tool_calls: [
            {
              index: 0,
              id: "skill",
              type: "function",
              function: { name: "Skill", arguments: '{"skill":"translate"}' },
            },
          ],
        }),
      );
      done(response, "tool_calls");
    } else {
      send(response, chunk({ content: "Skill applied" }));
      done(response);
    }
  });
  cleanup.push(() => server.close());
  const response = query({
    prompt: "Use translation",
    options: {
      ...structuredOptions(f.options, server.url),
      tools: ["Skill"],
      zpi: {
        ...structuredOptions(f.options, server.url).zpi,
        resourceLoader: {
          reload,
          getInstructions: () => [`RESOURCE_REVISION_${revision}`],
          listSkills: () => ({ skills: [], diagnostics: [] }),
        },
        plugins: [
          {
            id: "translation",
            version: "1",
            skills: [
              {
                name: "translate",
                description: "Translate",
                path: "/virtual/SKILL.md",
                baseDir: "/virtual",
                body: "FROZEN_TRANSLATION_SKILL",
              },
            ],
          },
        ],
      },
    },
  });
  await response.initializationResult();
  expect(reload).toHaveBeenCalledOnce();
  const messages: SDKMessage[] = [];
  for await (const message of response) messages.push(message);
  expect(result(messages)).toMatchObject({ subtype: "success", result: "Skill applied" });
  expect(revision).toBeGreaterThan(1);
  const initialMessages = server.requests[0].messages as { role: string; content: string }[];
  expect(initialMessages[0].content).not.toContain("RESOURCE_REVISION_");
  expect(initialMessages.findLast((message) => message.role === "system")?.content).toContain(
    "RESOURCE_REVISION_2",
  );
  expect(JSON.stringify(server.requests[1].messages)).toContain("FROZEN_TRANSLATION_SKILL");
});
