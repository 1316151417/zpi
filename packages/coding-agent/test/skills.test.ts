import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, test } from "vitest";
import { chunk, done, send } from "../../../tests/fake-server.ts";
import { buildMentionMarkdown, FileResourceLoader, parseInput, SkillCatalog } from "../src/index.ts";
import { fixture as resourceFixture, skill as writeSkill } from "./helpers/resource-fixture.ts";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const action of cleanup.splice(0).reverse()) await action();
});
async function temp() {
  const dir = await mkdtemp(join(tmpdir(), "ZPI-skills-"));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
test("shared agents skills are discovered, ZPI overrides duplicates, and global discovery omits project resources", async () => {
  const cwd = await temp(),
    agentDir = join(cwd, "agent"),
    userRoot = join(cwd, "home/.agents/skills");
  await writeSkill(userRoot, "shared", "Shared skill");
  await writeSkill(userRoot, "review", "Shared review");
  await writeSkill(join(agentDir, "skills"), "review", "ZPI review");
  await writeSkill(join(cwd, ".agents/skills"), "project", "Project skill");
  const loader = new FileResourceLoader({
    cwd,
    agentDir,
    userSkillPaths: [userRoot],
    projectResources: false,
  });
  await loader.reload();
  expect(
    loader
      .listSkills()
      .skills.map((s) => s.name)
      .sort(),
  ).toEqual(["review", "shared"]);
  expect(loader.listSkills().skills.find((s) => s.name === "review")?.description).toBe("ZPI review");
  const disabled = loader.listSkills().skills.find((s) => s.name === "review")?.path;
  const catalog = new SkillCatalog({
    cwd,
    agentDir,
    userSkillPaths: [userRoot],
    projectResources: false,
    isSkillEnabled: (p) => p !== disabled,
  });
  await catalog.reload();
  expect(catalog.listSkills().skills.map((s) => s.name)).toEqual(["shared"]);
  expect(catalog.listDiscoveredSkills().filter((s) => s.name === "review")).toHaveLength(2);
});
it.each(["name: other", "name: React Best Practices", "name: 123", `name: ${"a".repeat(65)}`, ""])(
  "uses the skill directory name without diagnostics for frontmatter %j",
  async (name) => {
    const cwd = await temp();
    const root = join(cwd, ".agents", "skills");
    await writeSkill(root, "react-best-practices", "React guidance");
    await writeFile(
      join(root, "react-best-practices", "SKILL.md"),
      `---\n${name}\ndescription: React guidance\n---\nSKILL BODY`,
    );
    const loader = new FileResourceLoader({ cwd, agentDir: join(cwd, "agent"), userSkillPaths: [] });
    await loader.reload();
    expect(loader.getDiagnostics()).toEqual([]);
    expect(loader.listSkills().skills.map((skill) => skill.name)).toEqual(["react-best-practices"]);
    expect(loader.getAppendSystemPrompt().join("\n")).toContain("<name>react-best-practices</name>");
    expect(await loader.loadSkill("react-best-practices")).toMatchObject({
      name: "react-best-practices",
      body: "SKILL BODY",
    });
  },
);
it("instructions are ordered, skills are metadata-only, project overrides user, bad YAML is diagnosed", async () => {
  const f = await resourceFixture((_, r) => {
    send(r, chunk({ content: "ok" }));
    done(r);
  });
  await writeFile(join(f.agentDir, "AGENTS.md"), "USER RULE");
  await writeFile(join(f.dir, "AGENTS.md"), "ANCESTOR RULE");
  await writeFile(join(f.cwd, "AGENTS.md"), "PROJECT RULE");
  await writeSkill(join(f.agentDir, "skills"), "review", "User review", "USER SECRET BODY");
  await writeSkill(
    join(f.cwd, ".ZPI", "skills"),
    "review",
    "Project review",
    "PROJECT SECRET BODY\nUse references/check.md",
  );
  await writeSkill(join(f.cwd, ".ZPI", "skills"), "another", "Another", "ANOTHER BODY");
  await mkdir(join(f.cwd, ".ZPI", "skills", "broken"));
  await writeFile(
    join(f.cwd, ".ZPI", "skills", "broken", "SKILL.md"),
    "---\nname: [bad\ndescription: bad\n---\n",
  );
  const loader = new FileResourceLoader({ userSkillPaths: [], cwd: f.cwd, agentDir: f.agentDir });
  await loader.reload();
  const prompt = loader.getAppendSystemPrompt().join("\n");
  expect(prompt.indexOf("USER RULE")).toBeLessThan(prompt.indexOf("ANCESTOR RULE"));
  expect(prompt.indexOf("ANCESTOR RULE")).toBeLessThan(prompt.indexOf("PROJECT RULE"));
  expect(prompt).toContain("Project review");
  expect(prompt).not.toContain("SECRET BODY");
  expect(loader.listSkills().skills).toHaveLength(2);
  expect(loader.listSkills().diagnostics[0].path).toContain("broken/SKILL.md");
  expect(await loader.loadSkill("review")).toMatchObject({
    source: "project",
    body: "PROJECT SECRET BODY\nUse references/check.md",
    baseDir: await realpath(join(f.cwd, ".ZPI", "skills", "review")),
  });
  await expect(loader.loadSkill("missing")).rejects.toThrow("not found");
  const extraRoot = join(f.dir, "extra-skills");
  await writeSkill(extraRoot, "extra-only", "Extra source", "EXTRA BODY");
  await writeSkill(extraRoot, "review", "Extra review", "EXTRA OVERRIDDEN BODY");
  const extended = new FileResourceLoader({
    userSkillPaths: [],
    cwd: f.cwd,
    agentDir: f.agentDir,
    additionalSkillPaths: [extraRoot],
  });
  await extended.reload();
  expect(extended.listSkills().skills).toHaveLength(3);
  expect(await extended.loadSkill("extra-only")).toMatchObject({ source: "extra", body: "EXTRA BODY" });
  expect(await extended.loadSkill("review")).toMatchObject({ source: "project" });
  expect(extended.getAppendSystemPrompt().join("\n")).not.toContain("EXTRA BODY");
});

it("explicit skills expand only at input start and invalid skills never reach the provider", async () => {
  const f = await resourceFixture((_, r) => {
    send(r, chunk({ content: "ok" }));
    done(r);
  });
  await writeSkill(join(f.cwd, ".ZPI", "skills"), "review", "Review", "BODY ON DEMAND");
  await f.session.submit("$review check sources");
  expect(JSON.stringify(f.server.requests[0])).toContain("BODY ON DEMAND");
  expect(f.server.requestHeaders[0].authorization).toBeUndefined();
  const missing = buildMentionMarkdown("$missing", join(f.cwd, ".ZPI", "skills", "missing", "SKILL.md"));
  await expect(f.session.submit(`${missing} do it`)).rejects.toThrow("not found");
  expect(f.server.requests).toHaveLength(1);
  expect(parseInput("Mention /compact and $review")).toEqual({
    kind: "prompt",
    text: "Mention /compact and $review",
  });
});

it("unknown dollar-prefixed text is sent unchanged without expanding a skill", async () => {
  const f = await resourceFixture((_, r) => {
    send(r, chunk({ content: "ok" }));
    done(r);
  });
  await writeSkill(join(f.cwd, ".ZPI", "skills"), "review", "Review", "BODY ON DEMAND");
  const text = "  $100 is the price\n$review is mentioned later  ";
  await f.session.submit(text);
  expect(f.server.requests[0].messages).toContainEqual(
    expect.objectContaining({ role: "user", content: text }),
  );
  expect(JSON.stringify(f.server.requests[0])).not.toContain("BODY ON DEMAND");
});
