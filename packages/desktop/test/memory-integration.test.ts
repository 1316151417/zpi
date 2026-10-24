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
  [true, true],
])(
  "freezes independent short=%s long=%s switches and refreshes content only at user boundaries",
  async (short, long) => {
    const f = await fixture();
    await mkdir(join(f.resources, ".zpi"), { recursive: true });
    const path = join(f.resources, ".zpi", "MEMORY.md");
    await writeFile(path, "# Memory\n- [language] USER_MEMORY_FIRST\n");
    await f.host.saveMemorySettings({ ...defaultMemorySettings, short, long });
    const context = vi.spyOn(f.host.longMemory, "context").mockResolvedValue({
      instructions: ["LONG_SUMMARY_MARKER"],
      sources: [],
      release: () => {},
    });
    const check = vi.spyOn(f.host.longMemory, "check").mockResolvedValue();
    await run(f, "first");
    const system = () => f.host.sessions.get(f.session.id)?.systemPrompt ?? "";
    expect(system().includes("USER_MEMORY_FIRST")).toBe(short);
    expect(system().includes("LONG_SUMMARY_MARKER")).toBe(long);
    expect(check).toHaveBeenCalledTimes(long ? 1 : 0);
    expect(context.mock.calls.length > 0).toBe(long);
    await f.host.saveMemorySettings({ ...defaultMemorySettings, short: !short, long: !long });
    await writeFile(path, "# Memory\n- [language] USER_MEMORY_SECOND\n");
    expect(system().includes("USER_MEMORY_SECOND")).toBe(false);
    await run(f, "second");
    expect(system().includes("USER_MEMORY_SECOND")).toBe(short);
    expect(system().includes("USER_MEMORY_FIRST")).toBe(false);
    expect(system().includes("LONG_SUMMARY_MARKER")).toBe(long);
    const next = f.host.createSession(null);
    await f.host.startRun({ sessionId: next.id, text: "new session" });
    await f.host.activeRuns.get(next.id)?.done;
    expect(f.host.sessions.get(next.id)?.systemPrompt.includes("USER_MEMORY_SECOND")).toBe(!short);
    expect(f.host.sessions.get(next.id)?.systemPrompt.includes("LONG_SUMMARY_MARKER")).toBe(!long);
    expect(await readFile(path, "utf8")).toContain("USER_MEMORY_SECOND");
  },
);

test("loads the bound worktree project file, excludes project files without a project, and exposes diagnostics", async () => {
  const f = await fixture();
  await f.host.saveMemorySettings({ ...defaultMemorySettings, short: true });
  await writeFile(join(f.workspace, "MEMORY.md"), "# Memory\n- [root] MAIN_CHECKOUT_MEMORY\n");
  await run(f, "projectless");
  expect(f.host.sessions.get(f.session.id)?.systemPrompt).not.toContain("MAIN_CHECKOUT_MEMORY");
  const project = await f.host.addProject(f.workspace);
  const worktree = join(f.dir, "worktree");
  await mkdir(worktree);
  await writeFile(join(worktree, "MEMORY.md"), "# Memory\n- [branch] WORKTREE_MEMORY\n");
  const session = f.host.createSession(project.id, { cwd: worktree });
  await f.host.startRun({ sessionId: session.id, text: "bound checkout" });
  await f.host.activeRuns.get(session.id)?.done;
  expect(f.host.sessions.get(session.id)?.systemPrompt).toContain("WORKTREE_MEMORY");
  expect(f.host.sessions.get(session.id)?.systemPrompt).not.toContain("MAIN_CHECKOUT_MEMORY");
  const path = join(worktree, "MEMORY.md");
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
    if (text.includes("Extract reusable memory"))
      output = JSON.stringify({
        rawMemory: "Project-specific tested procedure",
        rolloutSummary: "Verified outcome with original evidence",
      });
    if (text.includes("Consolidate historical evidence")) {
      const source = text.match(/rollout_summaries\/[a-f0-9]+\.md/)?.[0];
      output = JSON.stringify({
        memory: `# Project memory\nDETAIL_ONLY_MARKER\n${source}`,
        summary: "## Memory index\nSUMMARY_ONLY_MARKER",
      });
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
  const trigger = host.createSession(null);
  await host.startRun({ sessionId: trigger.id, text: "new task" });
  await host.activeRuns.get(trigger.id)?.done;
  await vi.waitFor(() => expect(host.longMemory.status().status).toBe("success"));
  const status = host.longMemory.status();
  expect(status.sources.map((item) => item.sessionId)).toEqual([sourceId]);
  expect(status.tokens).toBe(60);
  const extraction = f.server.requests.find((request) =>
    JSON.stringify(request.messages).includes("Extract reusable memory"),
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
  await mkdir(join(f.dir, "memories"), { recursive: true });
  await writeFile(join(f.dir, "memories", "memory_notes.md"), "Remember this explicit scoped request.");
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
  await expect(f.host.openMemoryFile(null, "project", "edit")).rejects.toThrow("没有项目");
  await expect(f.host.openMemoryFile(null, "long", "edit")).rejects.toThrow("后台维护");
});
