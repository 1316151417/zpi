import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { chunk, done, send } from "../../../tests/fake-server.ts";
import { SessionHost } from "../src/main/session-host.ts";
import { defaultMemorySettings } from "../src/shared/memory.ts";
import { cleanup, fixture, run } from "./helpers/context-fixture.ts";

test.each([
  [false, false],
  [true, false],
  [false, true],
])(
  "freezes exclusive short=%s long=%s switches and refreshes content only at user boundaries",
  async (short, long) => {
    const f = await fixture();
    await mkdir(join(f.resources, ".zpi"), { recursive: true });
    const path = join(f.resources, ".zpi", "MEMORY.md");
    await writeFile(path, "# Memory\n- [language] USER_MEMORY_FIRST\n");
    await f.host.saveMemorySettings({ ...defaultMemorySettings, short, long });
    const context = vi.spyOn(f.host.longMemory, "context").mockResolvedValue({
      instructions: ["LONG_SUMMARY_MARKER"],
      sources: [],
    });
    const check = vi.spyOn(f.host.longMemory, "check").mockResolvedValue();
    await run(f, "first");
    const system = () => f.host.sessions.get(f.session.id)?.systemPrompt ?? "";
    expect(system().includes("USER_MEMORY_FIRST")).toBe(short);
    expect(system().includes("LONG_SUMMARY_MARKER")).toBe(long);
    expect(check).toHaveBeenCalledTimes(long ? 1 : 0);
    expect(context.mock.calls.length > 0).toBe(long);
    const nextMode = long ? { short: true, long: false } : { short: false, long: true };
    await f.host.saveMemorySettings({ ...defaultMemorySettings, ...nextMode });
    await writeFile(path, "# Memory\n- [language] USER_MEMORY_SECOND\n");
    expect(system().includes("USER_MEMORY_SECOND")).toBe(false);
    await run(f, "second");
    expect(system().includes("USER_MEMORY_SECOND")).toBe(short);
    expect(system().includes("USER_MEMORY_FIRST")).toBe(false);
    expect(system().includes("LONG_SUMMARY_MARKER")).toBe(long);
    const next = await f.host.createSession(null);
    await f.host.startRun({ sessionId: next.id, text: "new session" });
    await f.host.activeRuns.get(next.id)?.done;
    expect(f.host.sessions.get(next.id)?.systemPrompt.includes("USER_MEMORY_SECOND")).toBe(nextMode.short);
    expect(f.host.sessions.get(next.id)?.systemPrompt.includes("LONG_SUMMARY_MARKER")).toBe(nextMode.long);
    expect(await readFile(path, "utf8")).toContain("USER_MEMORY_SECOND");
  },
);

test("loads the bound worktree project file, excludes project files without a project, and exposes diagnostics", async () => {
  const f = await fixture();
  await f.host.saveMemorySettings({ ...defaultMemorySettings, short: true });
  await mkdir(join(f.workspace, ".zpi"), { recursive: true });
  await writeFile(join(f.workspace, ".zpi", "MEMORY.md"), "# Memory\n- [root] MAIN_CHECKOUT_MEMORY\n");
  await run(f, "projectless");
  expect(f.host.sessions.get(f.session.id)?.systemPrompt).not.toContain("MAIN_CHECKOUT_MEMORY");
  const project = await f.host.addProject(f.workspace);
  const worktree = join(f.dir, "worktree");
  await mkdir(join(worktree, ".zpi"), { recursive: true });
  await writeFile(join(worktree, ".zpi", "MEMORY.md"), "# Memory\n- [branch] WORKTREE_MEMORY\n");
  const session = await f.host.createSession(project.id, { cwd: worktree });
  await f.host.startRun({ sessionId: session.id, text: "bound checkout" });
  await f.host.activeRuns.get(session.id)?.done;
  expect(f.host.sessions.get(session.id)?.systemPrompt).toContain("WORKTREE_MEMORY");
  expect(f.host.sessions.get(session.id)?.systemPrompt).not.toContain("MAIN_CHECKOUT_MEMORY");
  const path = join(worktree, ".zpi", "MEMORY.md");
  await writeFile(path, `# Memory\n- [bad] ${"长".repeat(2001)}`);
  await f.host.startRun({ sessionId: session.id, text: "refresh" });
  await f.host.activeRuns.get(session.id)?.done;
  expect(f.host.sessions.get(session.id)?.systemPrompt).not.toContain("WORKTREE_MEMORY");
  expect(
    f.host.sessions
      .get(session.id)
      ?.getResourceDiagnostics()
      .some((item) => item.path === path),
  ).toBe(true);
  const status = await f.host.getMemoryStatus(session.id);
  expect(status.shortFiles.find((item) => item.scope === "project")?.characters).toBe(2001);
  expect((await f.host.openMemoryFile(session.id, "project", "view")).path).toBe(path);
  expect((await f.host.openMemoryFile(session.id, "project", "view")).content).toContain("长".repeat(2001));
});

test("runs both stages through a frozen model, publishes source snapshots and injects only the summary", async () => {
  const f = await fixture((body, response) => {
    const text = JSON.stringify(body.messages);
    const messages = body.messages as { role: string; content: string }[];
    const requestedPath = messages
      .findLast((message) => message.role === "user")
      ?.content.match(/^READ_MEMORY:(.+)/)?.[1];
    if (requestedPath && messages.at(-1)?.role !== "tool") {
      send(
        response,
        chunk({
          tool_calls: [
            {
              index: 0,
              id: "read-memory-source",
              type: "function",
              function: { name: "read", arguments: JSON.stringify({ path: requestedPath }) },
            },
          ],
        }),
      );
      done(response, "tool_calls");
      return;
    }
    let output = "foreground answer";
    if (text.includes("Your job is to extract information"))
      output = JSON.stringify({
        rollout_slug: "project-procedure",
        rollout_summary: "DETAIL_ONLY_MARKER: Verified outcome with original evidence",
      });
    if (text.includes("Consolidate the supplied rollout summaries")) {
      const tools = body.tools as { function: { name: string } }[];
      expect(tools.map((tool) => tool.function.name).sort()).toEqual(["edit", "read", "write"]);
      const results = messages.filter((message) => message.role === "tool").length;
      const toolCall = (name: string, args: object) => {
        send(
          response,
          chunk({
            tool_calls: [
              {
                index: 0,
                id: `worker-${results}`,
                type: "function",
                function: { name, arguments: JSON.stringify(args) },
              },
            ],
          }),
        );
        send(response, {
          choices: [],
          usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
        });
        done(response, "tool_calls");
      };
      if (results === 0) {
        toolCall("read", { path: "phase2_workspace_diff.md" });
        return;
      }
      if (results === 1) {
        toolCall("write", {
          path: "memory_summary.md",
          content:
            "v1\n## User Profile\n\n## User preferences\n\n## General Tips\n\n## What's in Memory\nSUMMARY_ONLY_MARKER",
        });
        return;
      }
      output = "Memory summary updated.";
    }
    send(response, chunk({ content: output }));
    send(response, { choices: [], usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } });
    done(response);
  });
  await run(f, "Remember the reusable project procedure after its verification.");
  const sourceId = f.session.id;
  await f.host.close();
  const task = f.settings.state.getTask(sourceId);
  if (!task) throw new Error("missing source");
  f.settings.state.upsertTask({ ...task, updatedAt: Date.now() - 7 * 3600_000 });
  f.settings.saveMemorySettings({ ...defaultMemorySettings, long: true });
  const host = new SessionHost(f.dir, f.settings, f.resources, f.workspace);
  cleanup.push(() => host.close());
  await host.init();
  const trigger = await host.createSession(null);
  await host.startRun({ sessionId: trigger.id, text: "new task" });
  await host.activeRuns.get(trigger.id)?.done;
  await vi.waitFor(() => expect(host.longMemory.status().status).toBe("success"), { timeout: 5000 });
  const status = host.longMemory.status();
  expect(status.sources.map((item) => item.sessionId)).toEqual([sourceId]);
  expect(status.tokens).toBe(120);
  const extraction = f.server.requests.find((request) =>
    JSON.stringify(request.messages).includes("Your job is to extract information"),
  );
  expect(extraction?.model).toBe("vision");
  expect(JSON.stringify(extraction?.messages)).not.toContain("<system_rules>");
  const summary = await readFile(status.sources[0].summaryPath as string, "utf8");
  expect(summary).toContain(sourceId);
  expect(summary).toContain("evidence_path:");
  const evidencePath = JSON.parse(/evidence_path: (.+)/.exec(summary)?.[1] ?? '""') as string;
  expect(await readFile(evidencePath, "utf8")).toContain("Remember the reusable project procedure");
  await host.startRun({ sessionId: trigger.id, text: "continue" });
  await host.activeRuns.get(trigger.id)?.done;
  expect(host.sessions.get(trigger.id)?.systemPrompt).toContain("SUMMARY_ONLY_MARKER");
  expect(host.sessions.get(trigger.id)?.systemPrompt).not.toContain("DETAIL_ONLY_MARKER");
  await host.startRun({ sessionId: trigger.id, text: `READ_MEMORY:${status.sources[0].summaryPath}` });
  await host.activeRuns.get(trigger.id)?.done;
  expect((await host.getMemoryStatus(trigger.id)).usedSources?.map((item) => item.sessionId)).toEqual([
    sourceId,
  ]);
  const before = f.server.requests.length;
  await host.checkMemoryNow(trigger.id);
  await vi.waitFor(() => expect(host.longMemory.status().running).toBe(false));
  expect(f.server.requests.length).toBe(before);
  await host.saveMemorySettings({ ...defaultMemorySettings, long: true, generate: false });
  expect(host.longMemory.status().status).toBe("paused");
  await host.startRun({ sessionId: trigger.id, text: "while paused" });
  await host.activeRuns.get(trigger.id)?.done;
  expect(host.sessions.get(trigger.id)?.systemPrompt).toContain("SUMMARY_ONLY_MARKER");
  await host.clearLongMemory();
  await host.saveMemorySettings({ ...defaultMemorySettings, long: true });
  await host.checkMemoryNow(trigger.id);
  await vi.waitFor(() => expect(host.longMemory.status().running).toBe(false));
  expect(host.longMemory.status().sources).toEqual([]);
  expect(host.sessionPath(sourceId)).toBeTruthy();
  await mkdir(join(f.dir, "memories_v2"), { recursive: true });
  await mkdir(join(f.dir, "memories_v2", "extensions", "ad_hoc", "notes"), { recursive: true });
  await writeFile(
    join(f.dir, "memories_v2", "extensions", "ad_hoc", "notes", "request.md"),
    "Remember this explicit scoped request.",
  );
  await host.saveMemorySettings({
    ...defaultMemorySettings,
    long: true,
    modelMode: "manual",
    selection: { provider: "missing-provider", modelId: "missing-model", reasoning: "none" },
  });
  const callsBeforeUnavailable = f.server.requests.length;
  await host.checkMemoryNow(trigger.id);
  await vi.waitFor(() => expect(host.longMemory.status().status).toBe("failed"));
  expect(host.longMemory.status().message).toContain("不可用");
  expect(f.server.requests.length).toBe(callsBeforeUnavailable);
});

test("explicit edit creates only missing short memory files and never overwrites existing contents", async () => {
  const f = await fixture();
  const viewed = await f.host.openMemoryFile(null, "user", "view");
  expect(viewed.content).toBe("");
  await expect(readFile(viewed.path)).rejects.toMatchObject({ code: "ENOENT" });
  expect((await f.host.openMemoryFile(null, "user", "edit")).content).toBe("# Memory\n");
  await writeFile(viewed.path, "existing custom text");
  expect((await f.host.openMemoryFile(null, "user", "edit")).content).toBe("existing custom text");
  const project = await f.host.addProject(f.workspace);
  const session = await f.host.createSession(project.id);
  const projectPath = join(f.workspace, ".zpi", "MEMORY.md");
  expect(await f.host.openMemoryFile(session.id, "project", "view")).toEqual({
    path: projectPath,
    content: "",
    exists: false,
  });
  await expect(readFile(projectPath)).rejects.toMatchObject({ code: "ENOENT" });
  expect((await f.host.openMemoryFile(session.id, "project", "edit")).content).toBe("# Memory\n");
  await writeFile(projectPath, "existing project memory");
  expect((await f.host.openMemoryFile(session.id, "project", "edit")).content).toBe(
    "existing project memory",
  );
  await expect(readFile(join(f.workspace, "MEMORY.md"))).rejects.toMatchObject({ code: "ENOENT" });
  await expect(f.host.openMemoryFile(null, "project", "edit")).rejects.toThrow("没有项目");
  await expect(f.host.openMemoryFile(null, "long", "edit")).rejects.toThrow("后台维护");
});

test("restored legacy dual-memory sessions select long memory and persist an exclusive configuration", async () => {
  const f = await fixture();
  await mkdir(join(f.resources, ".zpi"), { recursive: true });
  await writeFile(join(f.resources, ".zpi", "MEMORY.md"), "- [language] LEGACY_SHORT_MEMORY\n");
  await f.host.saveMemorySettings({ ...defaultMemorySettings, short: true });
  await run(f, "An existing short-memory session.");
  await f.host.close();
  const task = f.settings.state.getTask(f.session.id);
  if (!task) throw new Error("Missing session");
  const config = task.frozenConfiguration as { memory: { short: boolean; long: boolean } };
  f.settings.state.upsertTask({
    ...task,
    frozenConfiguration: { ...config, memory: { short: true, long: true } },
  });
  const host = new SessionHost(f.dir, f.settings, f.resources, f.workspace);
  cleanup.push(() => host.close());
  await host.init();
  vi.spyOn(host.longMemory, "context").mockResolvedValue({
    instructions: ["RESTORED_LONG_MEMORY"],
    sources: [],
  });
  vi.spyOn(host.longMemory, "check").mockResolvedValue();
  await host.startRun({ sessionId: f.session.id, text: "Continue the legacy session." });
  await host.activeRuns.get(f.session.id)?.done;
  const prompt = host.sessions.get(f.session.id)?.systemPrompt;
  expect(prompt).toContain("RESTORED_LONG_MEMORY");
  expect(prompt).not.toContain("LEGACY_SHORT_MEMORY");
  expect(f.settings.state.getTask(f.session.id)?.frozenConfiguration).toMatchObject({
    memory: { short: false, long: true },
  });
});

test("the main agent appends separate notes and the real consolidation runner reads instructions and notes before publishing", async () => {
  let library = "";
  const noteA = "Remember Chinese responses for project A. NOTE_A_BODY";
  const noteB = "Correction: English responses for project A. NOTE_B_BODY";
  const summary =
    "v1\n## User Profile\n\n## User preferences\nEnglish responses for project A. [ad-hoc note]\n\n## General Tips\n\n## What's in Memory\n";
  const f = await fixture((body, response) => {
    const messages = body.messages as { role: string; content: string }[];
    const consolidation = JSON.stringify(messages).includes("Consolidate the supplied rollout summaries");
    const emitTool = (name: string, args: object) => {
      send(
        response,
        chunk({
          tool_calls: [
            {
              index: 0,
              id: `call-${messages.length}`,
              type: "function",
              function: { name, arguments: JSON.stringify(args) },
            },
          ],
        }),
      );
      done(response, "tool_calls");
    };
    if (consolidation) {
      const results = messages.filter(({ role }) => role === "tool");
      if (results.length === 0) return emitTool("read", { path: "phase2_workspace_diff.md" });
      if (results.length === 1) return emitTool("read", { path: "extensions/ad_hoc/instructions.md" });
      if (results.length === 2) {
        expect(JSON.stringify(results.at(-1))).toContain("Never delete a note file");
        return emitTool("read", { path: "extensions/ad_hoc/notes/remember.md" });
      }
      if (results.length === 3) return emitTool("read", { path: "extensions/ad_hoc/notes/correct.md" });
      if (results.length === 4) {
        expect(JSON.stringify(results)).toContain("NOTE_A_BODY");
        expect(JSON.stringify(results)).toContain("NOTE_B_BODY");
        return emitTool("write", { path: "memory_summary.md", content: summary });
      }
    } else if (body.tools) {
      const lastUser = messages.findLastIndex(({ role }) => role === "user");
      const request = messages[lastUser]?.content ?? "";
      if (!messages.slice(lastUser + 1).some(({ role }) => role === "tool")) {
        if (request === "NOTE_REQUEST_A")
          return emitTool("write", {
            path: join(library, "extensions/ad_hoc/notes/remember.md"),
            content: noteA,
          });
        if (request === "NOTE_REQUEST_B")
          return emitTool("write", {
            path: join(library, "extensions/ad_hoc/notes/correct.md"),
            content: noteB,
          });
      }
    }
    send(response, chunk({ content: "Done." }));
    done(response);
  });
  library = join(f.dir, "memories_v2");
  await mkdir(join(f.resources, ".zpi"), { recursive: true });
  await writeFile(join(f.resources, ".zpi", "MEMORY.md"), "- [old] SHORT_MEMORY_MUST_STAY_OUT\n");
  await f.host.saveMemorySettings({ ...defaultMemorySettings, long: true, generate: false });
  await run(f, "NOTE_REQUEST_A");
  await run(f, "NOTE_REQUEST_B");
  const notePath = (name: string) => join(library, "extensions/ad_hoc/notes", name);
  expect(await readFile(notePath("remember.md"), "utf8")).toBe(noteA);
  expect(await readFile(notePath("correct.md"), "utf8")).toBe(noteB);
  const before = f.host.sessions.get(f.session.id)?.systemPrompt;
  expect(before).toContain("separate, uniquely named note");
  expect(before).not.toContain("NOTE_A_BODY");
  expect(before).not.toContain("SHORT_MEMORY_MUST_STAY_OUT");
  await f.host.saveMemorySettings({ ...defaultMemorySettings, long: true });
  await f.host.checkMemoryNow(f.session.id);
  await vi.waitFor(() => expect(f.host.longMemory.status().status).toBe("success"));
  expect(await readFile(join(library, "memory_summary.md"), "utf8")).toBe(summary);
  expect(await readFile(notePath("remember.md"), "utf8")).toBe(noteA);
  expect(await readFile(notePath("correct.md"), "utf8")).toBe(noteB);
  await run(f, "USE_MEMORY");
  const after = f.host.sessions.get(f.session.id)?.systemPrompt;
  expect(after).toContain("English responses for project A. [ad-hoc note]");
  expect(after).not.toContain("NOTE_A_BODY");
  expect(after).not.toContain("NOTE_B_BODY");
  expect(after).not.toContain("SHORT_MEMORY_MUST_STAY_OUT");
  const calls = f.server.requests.length;
  await f.host.checkMemoryNow(f.session.id);
  await vi.waitFor(() => expect(f.host.longMemory.status().running).toBe(false));
  expect(f.server.requests).toHaveLength(calls);
});
