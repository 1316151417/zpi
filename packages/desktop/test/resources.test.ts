import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { buildMentionMarkdown } from "zpi-coding-agent";
import { chunk, done, send } from "../../../tests/fake-server.ts";
import { pluginSystemRules } from "../src/main/desktop-prompt.ts";
import { SessionHost } from "../src/main/session-host.ts";
import { SettingsStore } from "../src/main/storage.ts";
import { defaultCapabilities } from "../src/shared/config.ts";
import { cleanup, codec, fixture, run } from "./helpers/context-fixture.ts";

const desktopSystemRules = pluginSystemRules(defaultCapabilities);

test("session resources remain bound to the project root after bash changes directory", async () => {
  const f = await fixture((_, response, index) => {
    if (index === 0) {
      send(
        response,
        chunk({
          tool_calls: [
            {
              index: 0,
              id: "cd",
              type: "function",
              function: {
                name: "bash",
                arguments: JSON.stringify({ command: "cd nested && pwd" }),
              },
            },
          ],
        }),
      );
      done(response, "tool_calls");
    } else {
      send(response, chunk({ content: "ok" }));
      done(response);
    }
  });
  const project = await f.host.addProject(f.workspace);
  f.session = f.host.createSession(project.id);
  const nested = join(f.workspace, "nested");
  await mkdir(join(nested, ".zpi", "skills", "nested-only"), { recursive: true });
  await mkdir(join(f.workspace, ".zpi", "skills", "root-only"), { recursive: true });
  await writeFile(join(f.workspace, "AGENTS.md"), "ROOT POLICY");
  await writeFile(join(nested, "AGENTS.md"), "NESTED POLICY");
  for (const [root, name] of [
    [f.workspace, "root-only"],
    [nested, "nested-only"],
  ]) {
    await writeFile(join(root, ".zpi", "skills", name, "SKILL.md"), "---\ndescription: guidance\n---\nBODY");
  }
  await run(f, "change directory");
  await run(f, "check resources again");
  expect(f.server.requests).toHaveLength(3);
  expect(f.server.requests[1].messages).toContainEqual(
    expect.objectContaining({ role: "tool", content: expect.stringContaining(join(project.path, "nested")) }),
  );
  for (const request of f.server.requests) {
    const messages = request.messages as unknown as { role: string; content: string }[];
    const prompt = messages.find((message) => message.role === "system")?.content;
    expect(prompt).toContain("ROOT POLICY");
    expect(prompt).toContain("<name>root-only</name>");
    expect(prompt).not.toContain("NESTED POLICY");
    expect(prompt).not.toContain("<name>nested-only</name>");
  }
  expect((await f.host.listSessionSkills(f.session.id)).skills.map((s) => s.name)).toEqual(["root-only"]);
  expect(f.host.workspaceInfo(f.session.id).cwd).toBe(project.path);
});

test.each(["/中文读杠", "$100", "$missing task", "@someone@example.com"])(
  "ordinary input %j reaches the provider and remains in desktop history",
  async (text) => {
    const f = await fixture();
    await run(f, text);
    expect(f.server.requests).toHaveLength(1);
    expect(f.server.requests[0].messages).toContainEqual(
      expect.objectContaining({ role: "user", content: text }),
    );
    expect(f.host.getSessionSnapshot(f.session.id).view.runs[0]).toMatchObject({
      userMessage: text,
      status: "completed",
    });
  },
);

test("desktop link instructions reach prompt previews, new runs and restored custom sessions", async () => {
  for (const template of [
    undefined,
    { id: "custom", name: "Custom", preamble: "Custom assistant", rules: "CUSTOM RULE" },
  ]) {
    const f = await fixture(undefined, template);
    f.settings.setCapabilityEnabled("subagents", false);
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
    );
    await restarted.init();
    cleanup.push(() => restarted.close());
    await restarted.startRun({ sessionId: f.session.id, text: "show clickable paths" });
    await restarted.activeRuns.get(f.session.id)?.done;
    assertLinks(requestPrompt(1));
  }
});

test("prompt snapshots and skill defaults survive restart; the read-only preview omits project context", async () => {
  const f = await fixture(undefined, {
    id: "mine",
    name: "Mine",
    preamble: "In {{cwd}} for {{project_name}} on {{platform}}",
    rules: "MY RULE",
  });
  const root = join(f.resources, ".zpi", "skills", "review");
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
  expect(JSON.stringify(f.server.requests[1])).not.toContain("BODY");
  expect(f.server.requests[1].messages).toContainEqual(
    expect.objectContaining({ role: "user", content: "$review task" }),
  );
  f.session = f.host.createSession(null);
  expect((await f.host.listSessionSkills(f.session.id)).skills).toHaveLength(0);
  const linked = `${buildMentionMarkdown("$review", path)} task`;
  await run(f, linked);
  expect(f.host.getSessionSnapshot(f.session.id).session.draft).toBe(false);
  expect(f.server.requests[2].messages).toContainEqual(
    expect.objectContaining({ role: "user", content: linked }),
  );
  expect(JSON.stringify(f.server.requests[2])).toContain("MY RULE");
  expect(JSON.stringify(f.server.requests[2])).not.toContain("available_skills");
  expect(JSON.stringify(f.server.requests[2])).not.toContain("BODY");
  f.session = original;
  await run(f, "original");
  expect(JSON.stringify(f.server.requests[3])).toContain("MY RULE");
  const restarted = new SessionHost(
    f.dir,
    new SettingsStore(f.dir, codec),
    f.resources,
    f.workspace,
    undefined,
  );
  await restarted.init();
  cleanup.push(() => restarted.close());
  await restarted.startRun({ sessionId: configured.id, text: "$review after restart" });
  await restarted.activeRuns.get(configured.id)?.done;
  expect(JSON.stringify(f.server.requests[4])).toContain("MY RULE");
  expect(JSON.stringify(f.server.requests[4])).not.toContain("BODY");
  expect(f.server.requests[4].messages).toContainEqual(
    expect.objectContaining({ role: "user", content: "$review after restart" }),
  );
  expect(f.host.listTools().map((t) => t.name)).toEqual([
    "read",
    "bash",
    "edit",
    "write",
    "AskUserQuestion",
    "Agent",
    "SendMessage",
    "TaskOutput",
    "TaskStop",
  ]);
});
