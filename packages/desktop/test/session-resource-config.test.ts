import { mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { SubagentProfiles } from "@zpi-dev/builtin-plugins/collaboration/profiles";
import { FileResourceLoader } from "@zpi-dev/coding-agent";
import { expect, test, vi } from "vitest";
import { CustomCommandsStore } from "../src/main/custom-commands.ts";
import { SessionHost } from "../src/main/session-host.ts";
import { type SessionResources, sessionResourceLoader } from "../src/main/session-resources.ts";
import { SettingsStore } from "../src/main/storage.ts";
import { cleanup, codec, fixture, run } from "./helpers/context-fixture.ts";

test("persists discovery and injected text in session configuration without rescanning on sends or cold resume", async () => {
  const f = await fixture();
  const root = join(f.resources, ".agents", "skills", "review");
  const commands = join(f.resources, ".zpi", "commands");
  await mkdir(join(root, "references"), { recursive: true });
  await mkdir(commands, { recursive: true });
  await writeFile(
    join(root, "SKILL.md"),
    "---\ndescription: Frozen review\n---\nORIGINAL SKILL\nRead references/guide.md",
  );
  await writeFile(join(root, "references", "guide.md"), "ORIGINAL GUIDE");
  await writeFile(
    join(commands, "review.md"),
    "---\ndescription: Review\nskills: review\n---\nORIGINAL COMMAND $ARGUMENTS",
  );
  await writeFile(join(f.workspace, "AGENTS.md"), "ORIGINAL POLICY");
  await writeFile(join(f.resources, ".zpi", "MEMORY.md"), "# Memory\n- [one] ORIGINAL MEMORY\n");
  f.host.plugins.saveSubagent({
    config: {
      name: "review-agent",
      description: "ORIGINAL AGENT",
      systemPrompt: "Original role",
      color: "blue",
      injectAgentsMd: true,
    },
    scope: "user",
    sessionId: null,
  });
  const reload = vi.spyOn(FileResourceLoader.prototype, "reload");
  const agents = vi.spyOn(SubagentProfiles.prototype, "listAsync");
  const commandScans = vi.spyOn(CustomCommandsStore.prototype, "list");
  try {
    await run(f, "first");
    expect(reload).toHaveBeenCalledTimes(1);
    expect(agents).toHaveBeenCalledTimes(1);
    const [skill] = (await f.host.listSessionSkills(f.session.id)).skills;
    expect(skill.path).toBe(await realpath(join(root, "SKILL.md")));
    const saved = JSON.stringify(f.settings.state.getTask(f.session.id)?.frozenConfiguration);
    expect(saved).toContain("ORIGINAL POLICY");
    expect(saved).toContain("ORIGINAL MEMORY");
    expect(saved).not.toContain("ORIGINAL SKILL");
    expect(saved).not.toContain("ORIGINAL GUIDE");
    expect(saved).not.toContain("ORIGINAL COMMAND");
    expect(saved).not.toContain("Original role");
    expect(saved).not.toContain('"systemPrompt"');
    expect(commandScans).toHaveBeenCalledTimes(2);
    await run(f, "/review first-read");
    expect(JSON.stringify(f.server.requests.at(-1))).toContain("ORIGINAL SKILL");
    await writeFile(join(f.workspace, "AGENTS.md"), "CHANGED POLICY");
    await writeFile(join(f.resources, ".zpi", "MEMORY.md"), "# Memory\n- [one] CHANGED MEMORY\n");
    await writeFile(join(commands, "review.md"), "---\nskills: review\n---\nCHANGED COMMAND $ARGUMENTS");
    await writeFile(join(root, "SKILL.md"), "---\ndescription: Changed description\n---\nCHANGED SKILL");
    await writeFile(join(root, "references", "guide.md"), "CHANGED GUIDE");
    await f.host.setSkillEnabled(join(root, "SKILL.md"), false);
    await f.host.customCommands.create({ name: "late", prompt: "LATE COMMAND" });
    reload.mockClear();
    agents.mockClear();
    commandScans.mockClear();
    await run(f, "/review follow-up");
    const request = JSON.stringify(f.server.requests.at(-1));
    for (const text of [
      "ORIGINAL POLICY",
      "ORIGINAL MEMORY",
      "ORIGINAL AGENT",
      "ORIGINAL COMMAND",
      "ORIGINAL SKILL", // Previously read content remains in message history.
      "CHANGED SKILL",
      "CHANGED COMMAND",
      "follow-up",
    ])
      expect(request).toContain(text);
    expect(request).not.toContain("CHANGED POLICY");
    expect(request).not.toContain("CHANGED MEMORY");
    expect(
      (await f.host.listSessionCustomCommands(f.session.id)).commands.map((command) => command.name),
    ).toEqual(["/review"]);
    expect((await f.host.listSessionSkills(f.session.id)).skills[0].description).toBe("Frozen review");
    expect(await readFile(join(root, "references", "guide.md"), "utf8")).toBe("CHANGED GUIDE");
    expect((await f.host.listSessionSkills(f.session.id)).skills[0].path).toBe(skill.path);
    expect(reload).not.toHaveBeenCalled();
    expect(agents).not.toHaveBeenCalled();
    expect(commandScans).not.toHaveBeenCalled();
    await f.host.close();
    const restarted = new SessionHost(f.dir, new SettingsStore(f.dir, codec), f.resources, f.workspace);
    cleanup.push(() => restarted.close());
    await restarted.init();
    expect((await restarted.listSessionSkills(f.session.id)).skills[0].path).toBe(skill.path);
    await restarted.startRun({ sessionId: f.session.id, text: "/review after restart" });
    await restarted.activeRuns.get(f.session.id)?.done;
    expect(JSON.stringify(f.server.requests.at(-1))).toContain("ORIGINAL MEMORY");
    expect(JSON.stringify(f.server.requests.at(-1))).toContain("CHANGED COMMAND after restart");
    expect(reload).not.toHaveBeenCalled();
    expect(agents).not.toHaveBeenCalled();
    expect(commandScans).not.toHaveBeenCalled();
    await rm(root, { recursive: true });
    await restarted.startRun({ sessionId: f.session.id, text: "ordinary input after source deletion" });
    await restarted.activeRuns.get(f.session.id)?.done;
    expect((await restarted.listSessionSkills(f.session.id)).skills[0].path).toBe(skill.path);
    await expect(
      restarted.startRun({ sessionId: f.session.id, text: "/review missing skill" }),
    ).rejects.toThrow("ENOENT");
    expect(reload).not.toHaveBeenCalled();
    expect(commandScans).not.toHaveBeenCalled();
    const next = await restarted.createSession(null, { cwd: f.workspace });
    await restarted.startRun({ sessionId: next.id, text: "new conversation" });
    await restarted.activeRuns.get(next.id)?.done;
    expect(JSON.stringify(f.server.requests.at(-1))).toContain("CHANGED POLICY");
    expect(JSON.stringify(f.server.requests.at(-1))).toContain("CHANGED MEMORY");
    expect((await restarted.listSessionSkills(next.id)).skills).toEqual([]);
  } finally {
    reload.mockRestore();
    agents.mockRestore();
    commandScans.mockRestore();
  }
});

test("forks and side chats inherit injected instructions without rediscovering removed sources", async () => {
  const f = await fixture();
  await writeFile(join(f.workspace, "AGENTS.md"), "INHERITED POLICY");
  await run(f, "original");
  await rm(join(f.workspace, "AGENTS.md"));
  const reload = vi.spyOn(FileResourceLoader.prototype, "reload");
  try {
    const runId = f.host.getSessionSnapshot(f.session.id).view.runs[0].runId;
    const fork = await f.host.forkSession(f.session.id, runId);
    const side = await f.host.createSideChat(f.session.id);
    for (const session of [fork, side]) {
      await f.host.startRun({ sessionId: session.id, text: "continue inherited conversation" });
      await f.host.activeRuns.get(session.id)?.done;
      expect(JSON.stringify(f.server.requests.at(-1))).toContain("INHERITED POLICY");
    }
    expect(reload).not.toHaveBeenCalled();
  } finally {
    reload.mockRestore();
  }
});

test("a failed first input leaves the draft free to capture updated resources on retry", async () => {
  const f = await fixture();
  await writeFile(join(f.workspace, "AGENTS.md"), "BEFORE RETRY");
  await mkdir(join(f.resources, ".zpi"), { recursive: true });
  await writeFile(join(f.resources, ".zpi", "MEMORY.md"), "# Memory\n- [one] BEFORE MEMORY RETRY\n");
  const capture = vi
    .spyOn(FileResourceLoader.prototype, "reload")
    .mockRejectedValueOnce(new Error("capture failed"));
  try {
    await expect(f.host.startRun({ sessionId: f.session.id, text: "first" })).rejects.toThrow(
      "capture failed",
    );
  } finally {
    capture.mockRestore();
  }
  expect(f.host.getSessionSnapshot(f.session.id).session.draft).toBe(true);
  await writeFile(join(f.workspace, "AGENTS.md"), "AFTER RETRY");
  await writeFile(join(f.resources, ".zpi", "MEMORY.md"), "# Memory\n- [one] AFTER MEMORY RETRY\n");
  await run(f, "retry");
  expect(JSON.stringify(f.server.requests.at(-1))).toContain("AFTER RETRY");
  expect(JSON.stringify(f.server.requests.at(-1))).not.toContain("BEFORE RETRY");
  expect(JSON.stringify(f.server.requests.at(-1))).toContain("AFTER MEMORY RETRY");
  expect(JSON.stringify(f.server.requests.at(-1))).not.toContain("BEFORE MEMORY RETRY");
});

test.each([true, false])(
  "legacy resume keeps only its existing context without discovery (historical resources: %s)",
  async (injected) => {
    const f = await fixture();
    if (injected) {
      await writeFile(join(f.workspace, "AGENTS.md"), "HISTORICAL POLICY");
      await mkdir(join(f.resources, ".zpi"), { recursive: true });
      await writeFile(join(f.resources, ".zpi", "MEMORY.md"), "# Memory\n- [one] HISTORICAL MEMORY\n");
    }
    await run(f, "before upgrade");
    const systems = structuredClone(
      f.host.sessions.get(f.session.id)?.messages.filter((message) => message.role === "system"),
    );
    const state = f.settings.state.getTask(f.session.id);
    if (!state) throw new Error("Missing task");
    const config = structuredClone(state.frozenConfiguration) as Record<string, unknown>;
    delete config.resources;
    f.settings.state.upsertTask({ ...state, frozenConfiguration: config });
    await f.host.close();
    await writeFile(join(f.workspace, "AGENTS.md"), "CURRENT DISK POLICY");
    await mkdir(join(f.resources, ".zpi", "commands"), { recursive: true });
    await writeFile(join(f.resources, ".zpi", "MEMORY.md"), "# Memory\n- [one] CURRENT DISK MEMORY\n");
    await writeFile(join(f.resources, ".zpi", "commands", "late.md"), "CURRENT DISK COMMAND");
    const skill = join(f.resources, ".agents", "skills", "late");
    await mkdir(skill, { recursive: true });
    await writeFile(join(skill, "SKILL.md"), "---\ndescription: CURRENT DISK SKILL\n---\nNew role");
    const reload = vi.spyOn(FileResourceLoader.prototype, "reload");
    const agents = vi.spyOn(SubagentProfiles.prototype, "listAsync");
    const syncAgents = vi.spyOn(SubagentProfiles.prototype, "list");
    const commands = vi.spyOn(CustomCommandsStore.prototype, "list");
    const restored = new SessionHost(f.dir, new SettingsStore(f.dir, codec), f.resources, f.workspace);
    cleanup.push(() => restored.close());
    const memory = vi.spyOn(restored.plugins.longMemory, "context");
    try {
      await restored.init();
      expect((await restored.listSessionSkills(f.session.id)).skills).toEqual([]);
      expect((await restored.listSessionCustomCommands(f.session.id)).commands).toEqual([]);
      await restored.startRun({ sessionId: f.session.id, text: "continue" });
      await restored.activeRuns.get(f.session.id)?.done;
      expect(
        restored.sessions.get(f.session.id)?.messages.filter((message) => message.role === "system"),
      ).toEqual(systems);
      const request = JSON.stringify(f.server.requests.at(-1));
      expect(request).not.toContain("CURRENT DISK");
      if (injected) {
        expect(request).toContain("HISTORICAL POLICY");
        expect(request).toContain("HISTORICAL MEMORY");
      }
      expect(
        (f.settings.state.getTask(f.session.id)?.frozenConfiguration as Record<string, unknown> | undefined)
          ?.resources,
      ).toBeUndefined();
      const runId = restored.getSessionSnapshot(f.session.id).view.runs[0].runId;
      const fork = await restored.forkSession(f.session.id, runId);
      const side = await restored.createSideChat(f.session.id);
      for (const child of [fork, side]) {
        await restored.startRun({ sessionId: child.id, text: "continue inherited history" });
        await restored.activeRuns.get(child.id)?.done;
        expect(JSON.stringify(f.server.requests.at(-1))).not.toContain("CURRENT DISK");
      }
      expect(reload).not.toHaveBeenCalled();
      expect(agents).not.toHaveBeenCalled();
      expect(syncAgents).not.toHaveBeenCalled();
      expect(commands).not.toHaveBeenCalled();
      expect(memory).not.toHaveBeenCalled();
    } finally {
      reload.mockRestore();
      agents.mockRestore();
      syncAgents.mockRestore();
      commands.mockRestore();
      memory.mockRestore();
    }
  },
);

test("skill bodies and references keep original paths and are read live, without copying their directory", async () => {
  const f = await fixture();
  const root = join(f.dir, "installed", "review");
  const alias = join(f.resources, ".agents", "skills", "linked-review");
  await mkdir(root, { recursive: true });
  await mkdir(dirname(alias), { recursive: true });
  const original = `---\ndescription: Linked skill\n---\nRead ${root}/guide.md and ${alias}/guide.md`;
  await writeFile(join(root, "SKILL.md"), original);
  await writeFile(join(root, "guide.md"), "INITIAL GUIDE");
  // These unused resources must never be traversed or copied at first send.
  await symlink(join(root, "missing"), join(root, "unused-link"));
  await writeFile(join(root, "unused-large-file"), Buffer.alloc(3 * 1024 * 1024));
  await symlink(root, alias, "dir");
  await run(f, "discover linked skill");
  const [skill] = (await f.host.listSessionSkills(f.session.id)).skills;
  expect(skill.path).toBe(await realpath(join(root, "SKILL.md")));
  const config = f.settings.state.getTask(f.session.id)?.frozenConfiguration as {
    resources: SessionResources;
  };
  const loader = sessionResourceLoader(config.resources);
  expect((await loader.loadSkill(skill.name)).body).toContain(`${root}/guide.md and ${alias}/guide.md`);
  await writeFile(join(root, "SKILL.md"), "---\ndescription: Updated skill\n---\nLATEST BODY");
  await writeFile(join(root, "guide.md"), "LATEST GUIDE");
  expect((await loader.loadSkill(skill.name)).body).toBe("LATEST BODY");
  expect(await readFile(join(root, "guide.md"), "utf8")).toBe("LATEST GUIDE");
  await rm(root, { recursive: true });
  await expect(loader.loadSkill(skill.name)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(readFile(join(root, "guide.md"))).rejects.toMatchObject({ code: "ENOENT" });
  await expect(readFile(join(f.dir, "session-resources", "manifests"))).rejects.toMatchObject({
    code: "ENOENT",
  });
});
