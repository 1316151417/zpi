import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { SessionHost } from "../src/main/session-host.ts";
import { SettingsStore } from "../src/main/storage.ts";
import { cleanup, codec, fixture, run } from "./helpers/context-fixture.ts";

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
