import { mkdir, readFile, realpath, symlink, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { chunk, done, send } from "../../../tests/fake-server.ts";
import { fixture } from "./helpers/host-fixture.ts";

it("canonicalizes trusted home aliases before checking command storage descendants", async () => {
  const { SessionHost } = await import("../src/main/session-host.ts");
  const { cleanup } = await import("./helpers/host-fixture.ts");
  const f = await fixture((_, response) => done(response));
  await f.host.close();
  const home = join(f.dir, "home"),
    alias = join(f.dir, "home-alias");
  await mkdir(home);
  await symlink(home, alias, "dir");
  const host = new SessionHost(f.dir, f.settings, alias);
  cleanup.push(() => host.close());
  await host.init();
  const command = await host.customCommands.create({ name: "review", prompt: "Review changes" });
  expect(command.filePath).toBe(join(await realpath(home), ".zpi", "commands", "review.md"));
  expect((await host.customCommands.list()).commands.map((item) => item.name)).toEqual(["/review"]);
});

it("uses the submitting session project before user commands and preserves original slash history", async () => {
  const { host, a, b, server } = await fixture((_, response) => {
    send(response, chunk({ content: "ok" }));
    done(response);
  });
  await host.customCommands.create({ name: "review", prompt: "USER $ARGUMENTS" });
  await host.commandServices(a.id).commands.create({ name: "review", prompt: "PROJECT A $1" });
  const sessionA = await host.createSession(a.id),
    sessionB = await host.createSession(b.id);
  host.activateSession(sessionB.id);
  const commandsA = await host.listSessionCustomCommands(sessionA.id);
  expect(commandsA.commands.filter((command) => command.name === "/review")).toHaveLength(1);
  expect(commandsA.commands[0].prompt).toBe("PROJECT A $1");
  await host.startRun({ sessionId: sessionA.id, text: '/review "first file"' });
  await host.activeRuns.get(sessionA.id)?.done;
  const messages = JSON.stringify(server.requests[0].messages);
  expect(messages).toContain("PROJECT A first file");
  expect(messages).not.toContain("USER first file");
  expect(host.getSessionSnapshot(sessionA.id).view.runs[0].userMessage).toBe('/review "first file"');
  await host.startRun({ sessionId: sessionB.id, text: "/review second" });
  await host.activeRuns.get(sessionB.id)?.done;
  expect(JSON.stringify(server.requests.at(-1)?.messages)).toContain("USER second");
});

it("disabled project command does not fall back to user command, and no request is accepted", async () => {
  const { host, a, server } = await fixture((_, response) => done(response));
  await host.customCommands.create({ name: "review", prompt: "USER" });
  const project = host.commandServices(a.id).commands;
  const command = await project.create({ name: "review", prompt: "PROJECT" });
  await project.setEnabled({ id: command.id, enabled: false });
  const session = await host.createSession(a.id);
  await expect(host.startRun({ sessionId: session.id, text: "/review" })).rejects.toThrow("禁用");
  expect(server.requests).toHaveLength(0);
  expect(host.getSessionSnapshot(session.id).view.runs).toHaveLength(0);
});

it("fresh disk content is used at invocation without scanning other framework directories", async () => {
  const { host, a, dir, server } = await fixture((_, response) => done(response));
  const command = await host.customCommands.create({ name: "review", prompt: "OLD" });
  const ignored = join(dir, "agent", ".agents", "commands");
  await mkdir(ignored, { recursive: true });
  await writeFile(join(ignored, "secret.md"), "DO NOT DISCOVER");
  await writeFile(command.filePath, "---\ndescription: Updated\n---\nNEW $ARGUMENTS");
  const session = await host.createSession(a.id);
  expect((await host.listSessionCustomCommands(session.id)).commands.map((item) => item.name)).toEqual([
    "/review",
  ]);
  await host.startRun({ sessionId: session.id, text: "/review now" });
  await host.activeRuns.get(session.id)?.done;
  expect(JSON.stringify(server.requests[0].messages)).toContain("NEW now");
  expect(await readFile(join(ignored, "secret.md"), "utf8")).toBe("DO NOT DISCOVER");
});

it("built-in init remains authoritative over a conflicting custom command", async () => {
  const { host, a, server } = await fixture((_, response) => done(response));
  await mkdir(host.customCommands.rootDirectory, { recursive: true });
  await writeFile(join(host.customCommands.rootDirectory, "init.md"), "SHADOWED BUILTIN");
  expect(
    (await host.customCommands.list()).diagnostics.some((item) => item.code === "unsupported_name"),
  ).toBe(true);
  const session = await host.createSession(a.id);
  await host.startRun({ sessionId: session.id, text: "/init" });
  await host.activeRuns.get(session.id)?.done;
  expect(JSON.stringify(server.requests[0].messages)).toContain("AGENTS.md");
  expect(JSON.stringify(server.requests[0].messages)).not.toContain("SHADOWED BUILTIN");
  expect(server.requests).toHaveLength(1);
});

it("shell expansion runs only on dispatch, once, in the submitting session and keeps display text", async () => {
  const { SessionHost } = await import("../src/main/session-host.ts");
  const { cleanup } = await import("./helpers/host-fixture.ts");
  const { deferred } = await import("../../../tests/fake-server.ts");
  const gate = deferred();
  const f = await fixture(async (_body, response) => {
    if (f.server.requests.length === 1) await gate.promise;
    done(response);
  });
  await f.host.close();
  const calls: Array<{ command: string; cwd: string; sessionId: string }> = [];
  const host = new SessionHost(
    f.dir,
    f.settings,
    join(f.dir, "agent"),
    undefined,
    undefined,
    undefined,
    undefined,
    async (command, context) => {
      calls.push({ command, cwd: context.cwd, sessionId: context.sessionId });
      return "MOCK OUTPUT";
    },
  );
  cleanup.push(() => host.close());
  await host.init();
  await host.commandServices(f.a.id).commands.create({ name: "shell", prompt: "Result !`fixture $1`" });
  const a = await host.createSession(f.a.id),
    b = await host.createSession(f.b.id);
  await host.listSessionCustomCommands(a.id);
  expect(calls).toHaveLength(0);
  await host.startRun({ sessionId: a.id, text: "first" });
  const queued = await host.submitInput({ sessionId: a.id, text: '/shell "file name"' });
  expect(queued).toHaveProperty("queueItemId");
  expect(calls).toHaveLength(0);
  host.activateSession(b.id);
  gate.resolve();
  await expect.poll(() => calls.length).toBe(1);
  await expect.poll(() => f.server.requests.length).toBe(2);
  await host.activeRuns.get(a.id)?.done;
  expect(calls[0]).toEqual({ command: "fixture file name", cwd: f.a.path, sessionId: a.id });
  expect(JSON.stringify(f.server.requests[1].messages)).toContain("MOCK OUTPUT");
  expect(host.getSessionSnapshot(a.id).view.runs.at(-1)?.userMessage).toBe('/shell "file name"');
});

it("abort cancels template preparation and never sends a model request or automatically retries shell", async () => {
  const { SessionHost } = await import("../src/main/session-host.ts");
  const { cleanup } = await import("./helpers/host-fixture.ts");
  const f = await fixture((_, response) => done(response));
  await f.host.close();
  let calls = 0;
  const host = new SessionHost(
    f.dir,
    f.settings,
    join(f.dir, "agent"),
    undefined,
    undefined,
    undefined,
    undefined,
    async (_command, context) => {
      calls++;
      return new Promise<string>((_resolve, reject) => {
        context.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    },
  );
  cleanup.push(() => host.close());
  await host.init();
  await host.customCommands.create({ name: "shell", prompt: "!`fixture`" });
  const session = await host.createSession(f.a.id);
  const run = await host.startRun({ sessionId: session.id, text: "/shell" });
  await expect.poll(() => calls).toBe(1);
  await host.abortRun({ sessionId: session.id, runId: run.runId });
  expect(host.getSessionSnapshot(session.id).view.runs[0].status).toBe("aborted");
  expect(f.server.requests).toHaveLength(0);
  expect(calls).toBe(1);
});

it("required skills use the owning session resource loader and preserve metadata on edit", async () => {
  const { host, a, server } = await fixture((_, response) => done(response));
  const skillDirectory = join(a.path, ".zpi", "skills", "review-skill");
  await mkdir(skillDirectory, { recursive: true });
  await writeFile(
    join(skillDirectory, "SKILL.md"),
    "---\nname: review-skill\ndescription: Fixture review skill\n---\nREQUIRED SKILL BODY",
  );
  const command = await host.commandServices(a.id).commands.create({ name: "review", prompt: "REVIEW" });
  await writeFile(command.filePath, "---\nskills: [review-skill]\ndisable-noninteractive: true\n---\nREVIEW");
  const session = await host.createSession(a.id);
  const catalog = await host.listSessionCustomCommands(session.id);
  expect(catalog.commands[0].disableNonInteractive).toBe(true);
  await host.startRun({ sessionId: session.id, text: "/review" });
  await host.activeRuns.get(session.id)?.done;
  expect(JSON.stringify(server.requests[0].messages)).toContain("REQUIRED SKILL BODY");
  expect(JSON.stringify(server.requests[0].messages)).not.toContain("invoke the Skill tool");
});

it("subagent mentions route through the existing Agent tool and honor session capability snapshots", async () => {
  const { host, settings, a, server } = await fixture((_, response) => done(response));
  settings.setCapabilityEnabled("subagents", true);
  const session = await host.createSession(a.id);
  expect(
    (await host.listSessionCustomCommands(session.id)).subagents?.some((agent) => agent.name === "Explore"),
  ).toBe(true);
  await host.startRun({ sessionId: session.id, text: "@Explore inspect the entry point" });
  await host.activeRuns.get(session.id)?.done;
  expect(JSON.stringify(server.requests[0].messages)).toContain('subagent_type \\"Explore\\"');
  expect(JSON.stringify(server.requests[0].tools)).toContain('"name":"Agent"');
  expect(host.getSessionSnapshot(session.id).view.runs[0].userMessage).toBe(
    "@Explore inspect the entry point",
  );
  settings.setCapabilityEnabled("subagents", false);
  expect((await host.listSessionCustomCommands(session.id)).subagents?.length).toBeGreaterThan(0);
  const disabled = await host.createSession(a.id);
  expect((await host.listSessionCustomCommands(disabled.id)).subagents).toEqual([]);
  await expect(host.startRun({ sessionId: disabled.id, text: "@Explore inspect" })).rejects.toThrow("未启用");
  expect(server.requests).toHaveLength(1);
});

it("internal subagent inputs never interpret user command templates or agent mentions", async () => {
  const shell = vi.fn(async () => "MOCK SHELL");
  const { host, a, server } = await fixture((_, response) => done(response), shell);
  await host.customCommands.create({ name: "shell", prompt: "!`MUST NEVER EXECUTE`" });
  const session = await host.createSession(a.id);
  await host.startRun({ sessionId: session.id, text: "/shell" }, undefined, true);
  await host.activeRuns.get(session.id)?.done;
  expect(JSON.stringify(server.requests[0].messages)).toContain("/shell");
  expect(JSON.stringify(server.requests[0].messages)).not.toContain("MUST NEVER EXECUTE");
  await host.startRun({ sessionId: session.id, text: "@Explore delegated text" }, undefined, true);
  await host.activeRuns.get(session.id)?.done;
  expect(JSON.stringify(server.requests[1].messages)).toContain("@Explore delegated text");
  expect(JSON.stringify(server.requests[1].messages)).not.toContain("Use the Agent tool with subagent_type");
  expect(shell).not.toHaveBeenCalled();
});

it("a readonly Agent delegation cannot run command shell templates", async () => {
  const { SessionHost } = await import("../src/main/session-host.ts");
  const { cleanup } = await import("./helpers/host-fixture.ts");
  let parentSent = false;
  const f = await fixture((body, response) => {
    const tools = JSON.stringify(body.tools);
    if (tools.includes('"name":"Agent"') && !parentSent) {
      parentSent = true;
      send(
        response,
        chunk({
          tool_calls: [
            {
              index: 0,
              id: "readonly-delegation",
              type: "function",
              function: {
                name: "Agent",
                arguments: JSON.stringify({
                  description: "Inspect",
                  prompt: "/shell",
                  subagent_type: "readonly-fixture",
                }),
              },
            },
          ],
        }),
      );
      done(response, "tool_calls");
    } else {
      send(response, chunk({ content: "done" }));
      done(response);
    }
  });
  await f.host.close();
  const shell = vi.fn(async () => "MOCK SHELL");
  const host = new SessionHost(
    f.dir,
    f.settings,
    join(f.dir, "agent"),
    undefined,
    undefined,
    undefined,
    undefined,
    shell,
  );
  cleanup.push(() => host.close());
  await host.init();
  f.settings.setCapabilityEnabled("subagents", true);
  host.saveSubagent({
    scope: "user",
    sessionId: null,
    config: {
      name: "readonly-fixture",
      description: "Read only",
      systemPrompt: "Inspect only",
      color: "blue",
      injectAgentsMd: false,
      tools: ["read"],
    },
  });
  await host.customCommands.create({ name: "shell", prompt: "!`fixture`" });
  const session = await host.createSession(f.a.id);
  await host.startRun({ sessionId: session.id, text: "delegate inspection" });
  await host.activeRuns.get(session.id)?.done;
  expect(shell).not.toHaveBeenCalled();
  const child = f.server.requests.find((body) => !JSON.stringify(body.tools).includes('"name":"Agent"'));
  expect(child).toBeDefined();
  expect(JSON.stringify(child?.messages)).toContain("/shell");
  expect(JSON.stringify(child?.tools)).not.toContain('"name":"bash"');
  await host.startRun({ sessionId: session.id, text: "/shell" });
  await host.activeRuns.get(session.id)?.done;
  expect(shell).toHaveBeenCalledTimes(1);
});

it("a command appearing during preparation cannot introduce unaccepted shell side effects", async () => {
  const shell = vi.fn(async () => "MOCK SHELL");
  const { host, a, server } = await fixture((_, response) => done(response), shell);
  const original = host.listSessionCustomCommands.bind(host);
  let reads = 0;
  const spy = vi.spyOn(host, "listSessionCustomCommands").mockImplementation(async (id) => {
    reads++;
    if (reads === 2) await host.customCommands.create({ name: "late", prompt: "!`fixture-never-run`" });
    return original(id);
  });
  const session = await host.createSession(a.id);
  try {
    await expect(host.startRun({ sessionId: session.id, text: "/late" })).rejects.toThrow("准备期间已更改");
    expect(server.requests).toHaveLength(0);
    expect(shell).not.toHaveBeenCalled();
  } finally {
    spy.mockRestore();
  }
});

it.each(["edited", "deleted", "disabled"])(
  "revalidates a command %s between both preparation catalog reads",
  async (change) => {
    const shell = vi.fn(async () => "MOCK SHELL");
    const { host, a, server } = await fixture((_, response) => done(response), shell);
    const command = await host.customCommands.create({ name: "race", prompt: "!`fixture-never-run`" });
    const original = host.listSessionCustomCommands.bind(host);
    let reads = 0;
    const spy = vi.spyOn(host, "listSessionCustomCommands").mockImplementation(async (id) => {
      if (++reads === 2) {
        if (change === "edited") await writeFile(command.filePath, "Changed !`fixture-never-run`");
        else if (change === "deleted") await unlink(command.filePath);
        else await host.customCommands.setEnabled({ id: command.id, enabled: false });
      }
      return original(id);
    });
    const session = await host.createSession(a.id);
    try {
      await host.startRun({ sessionId: session.id, text: "/race" });
      await host.activeRuns.get(session.id)?.done;
      const run = host.getSessionSnapshot(session.id).view.runs[0];
      expect(run.status).toBe("error");
      expect(JSON.stringify(run)).toContain(change === "disabled" ? "禁用" : "准备期间已更改");
      expect(reads).toBe(2);
      expect(server.requests).toHaveLength(0);
      expect(shell).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  },
);

it("uses the same normalized uppercase colon invocation in both preparation phases", async () => {
  const { host, a, server } = await fixture((_, response) => done(response));
  const directory = join(host.customCommands.rootDirectory, "Tools");
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "Review.md"), "NESTED $ARGUMENTS");
  const session = await host.createSession(a.id);
  await host.startRun({ sessionId: session.id, text: "/TOOLS:REVIEW argument" });
  await host.activeRuns.get(session.id)?.done;
  expect(JSON.stringify(server.requests[0].messages)).toContain("NESTED argument");
});
