import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { desktopSystemRules } from "../src/main/desktop-prompt.ts";
import { SessionHost } from "../src/main/session-host.ts";
import { SettingsStore } from "../src/main/storage.ts";
import { cleanup, codec, fixture, run } from "./helpers/context-fixture.ts";

test("desktop link instructions reach prompt previews, new runs and restored custom sessions", async () => {
  for (const template of [
    undefined,
    { id: "custom", name: "Custom", preamble: "Custom assistant", rules: "CUSTOM RULE" },
  ]) {
    const f = await fixture(undefined, template);
    const assertLinks = (prompt: string) => {
      expect(prompt).toContain("Return web URLs as Markdown links");
      expect(prompt).toContain("return local file references as Markdown links");
      expect(prompt).toContain("use absolute paths for link destinations");
      expect(prompt).toContain("[My Report.md](</absolute/path/My Report.md>)");
      expect(prompt).toContain("outside inline code and code blocks");
      expect(prompt).toContain("Prefer Markdown links for ordinary file references");
      expect(prompt).not.toContain("To cite a local file in your answer, use ::zcode-file-citation");
      expect(prompt).toContain(desktopSystemRules);
      if (template) expect(prompt).toContain("CUSTOM RULE");
    };
    const preview = await f.host.previewPrompt();
    assertLinks(preview.prompt);
    expect(preview.systemRules).toBe(desktopSystemRules);
    expect(preview.basePrompt).not.toContain("<system_rules>");
    expect(preview.basePrompt).not.toContain("return local file references as Markdown links");
    expect(preview.prompt.replace(`\n\n${preview.systemRules}`, "")).toBe(preview.basePrompt);
    await run(f, "list files and the preview URL");
    const requestPrompt = (index: number) => {
      const messages = f.server.requests[index].messages as unknown as { role: string; content: string }[];
      return messages.find((message) => message.role === "system")?.content ?? "";
    };
    const systemPrompt = requestPrompt(0);
    assertLinks(systemPrompt);
    expect(systemPrompt).toBe(preview.prompt);
    expect(systemPrompt.split("<system_rules>")).toHaveLength(2);
    await f.host.close();
    const restarted = new SessionHost(
      f.dir,
      new SettingsStore(f.dir, codec),
      f.resources,
      f.workspace,
      undefined,
      [],
    );
    await restarted.init();
    cleanup.push(() => restarted.close());
    await restarted.startRun({ sessionId: f.session.id, text: "show clickable paths" });
    await restarted.activeRuns.get(f.session.id)?.done;
    assertLinks(requestPrompt(1));
  }
});

test("legacy prompt snapshots and skill defaults survive restart; the read-only preview omits project context", async () => {
  const f = await fixture(undefined, {
    id: "mine",
    name: "Mine",
    preamble: "In {{cwd}} for {{project_name}} on {{platform}}",
    rules: "MY RULE",
  });
  const root = join(f.resources, "skills", "review");
  await mkdir(root, { recursive: true });
  await writeFile(join(root, "SKILL.md"), "---\nname: review\ndescription: review code\n---\nBODY");
  await writeFile(join(f.workspace, "AGENTS.md"), "PROJECT POLICY");
  const original = f.session;
  await run(f, "original first message");
  f.server.requests.splice(0);
  f.session = f.host.createSession(null);
  expect(f.session.draft).toBe(true);

  const preview = await f.host.previewPrompt();
  expect(preview.prompt).toContain("MY RULE");
  expect(preview.prompt).not.toContain("PROJECT POLICY");
  expect(preview.prompt).toContain("available_skills");
  const configured = f.session;
  await run(f, "one");
  expect(JSON.stringify(f.server.requests[0])).toContain("MY RULE");
  expect(JSON.stringify(f.server.requests[0])).toContain("PROJECT POLICY");
  const path = (await f.host.getSkillSettings()).skills[0].path;
  await f.host.setSkillEnabled(path, false);
  expect((await f.host.listSessionSkills(configured.id)).skills).toHaveLength(1);
  await run(f, "$review task");
  expect(JSON.stringify(f.server.requests[1])).toContain("MY RULE");
  expect(JSON.stringify(f.server.requests[1])).toContain("BODY");
  f.session = f.host.createSession(null);
  expect((await f.host.listSessionSkills(f.session.id)).skills).toHaveLength(0);
  await expect(run(f, "$review task")).rejects.toThrow("disabled");
  expect(f.host.getSessionSnapshot(f.session.id).session.draft).toBe(true);
  await run(f, "new session");
  expect(JSON.stringify(f.server.requests[2])).toContain("MY RULE");
  expect(JSON.stringify(f.server.requests[2])).not.toContain("available_skills");
  f.session = original;
  await run(f, "original");
  expect(JSON.stringify(f.server.requests[3])).toContain("MY RULE");
  const restarted = new SessionHost(
    f.dir,
    new SettingsStore(f.dir, codec),
    f.resources,
    f.workspace,
    undefined,
    [],
  );
  await restarted.init();
  cleanup.push(() => restarted.close());
  await restarted.startRun({ sessionId: configured.id, text: "$review after restart" });
  await restarted.activeRuns.get(configured.id)?.done;
  expect(JSON.stringify(f.server.requests[4])).toContain("MY RULE");
  expect(JSON.stringify(f.server.requests[4])).toContain("BODY");
  expect(f.host.listTools().map((t) => t.name)).toEqual(["read", "bash", "edit", "write"]);
});
