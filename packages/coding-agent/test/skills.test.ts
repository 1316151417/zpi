import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, test } from "vitest";
import { chunk, done, send } from "../../../tests/fake-server.ts";
import { buildMentionMarkdown, createAgentSession, FileResourceLoader, SkillCatalog } from "../src/index.ts";
import { fixture as resourceFixture, skill as writeSkill } from "./helpers/resource-fixture.ts";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const action of cleanup.splice(0).reverse()) await action();
});
async function temp() {
  const dir = await mkdtemp(join(tmpdir(), "zpi-skills-"));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
test("shared agents skills are discovered, ZPI overrides duplicates, and global discovery omits project resources", async () => {
  const cwd = await temp(),
    homeDir = join(cwd, "home"),
    userRoot = join(homeDir, ".agents/skills");
  await writeSkill(userRoot, "shared", "Shared skill");
  await writeSkill(userRoot, "review", "Shared review");
  await writeSkill(join(homeDir, ".zpi", "skills"), "review", "ZPI review");
  await writeSkill(join(cwd, ".agents/skills"), "project", "Project skill");
  const loader = new FileResourceLoader({
    projectDir: cwd,
    homeDir,
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
    projectDir: cwd,
    homeDir,
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
    const loader = new FileResourceLoader({ projectDir: cwd, homeDir: join(cwd, "home") });
    await loader.reload();
    expect(loader.getDiagnostics()).toEqual([]);
    expect(loader.listSkills().skills.map((skill) => skill.name)).toEqual(["react-best-practices"]);
    expect(loader.getInstructions().join("\n")).toContain("<name>react-best-practices</name>");
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
  const homeDir = join(f.dir, "home");
  await mkdir(join(homeDir, ".agents"), { recursive: true });
  await mkdir(join(homeDir, ".zpi"), { recursive: true });
  await mkdir(join(f.cwd, ".zpi"), { recursive: true });
  await writeFile(join(homeDir, ".agents", "AGENTS.md"), "SHARED USER RULE");
  await writeFile(join(homeDir, ".zpi", "AGENTS.md"), "ZPI USER RULE");
  await writeFile(join(f.cwd, ".zpi", "AGENTS.md"), "ZPI PROJECT RULE");
  await writeFile(join(f.dir, "AGENTS.md"), "ANCESTOR RULE");
  await writeFile(join(f.cwd, "AGENTS.md"), "PROJECT RULE");
  await writeSkill(join(homeDir, ".zpi", "skills"), "review", "User review", "USER SECRET BODY");
  await writeSkill(
    join(f.cwd, ".zpi", "skills"),
    "review",
    "Project review",
    "PROJECT SECRET BODY\nUse references/check.md",
  );
  await writeSkill(join(f.cwd, ".zpi", "skills"), "another", "Another", "ANOTHER BODY");
  await mkdir(join(f.cwd, ".zpi", "skills", "broken"));
  await writeFile(
    join(f.cwd, ".zpi", "skills", "broken", "SKILL.md"),
    "---\nname: [bad\ndescription: bad\n---\n",
  );
  const loader = new FileResourceLoader({ projectDir: f.cwd, homeDir });
  await loader.reload();
  const prompt = loader.getInstructions().join("\n");
  expect(prompt.indexOf("SHARED USER RULE")).toBeLessThan(prompt.indexOf("ZPI USER RULE"));
  expect(prompt.indexOf("ZPI USER RULE")).toBeLessThan(prompt.indexOf("PROJECT RULE"));
  expect(prompt.indexOf("PROJECT RULE")).toBeLessThan(prompt.indexOf("ZPI PROJECT RULE"));
  expect(prompt).not.toContain("ANCESTOR RULE");
  expect(prompt).toContain("Project review");
  expect(prompt).not.toContain("SECRET BODY");
  expect(loader.listSkills().skills).toHaveLength(2);
  expect(loader.listSkills().diagnostics[0].path).toContain("broken/SKILL.md");
  expect(await loader.loadSkill("review")).toMatchObject({
    source: "project",
    body: "PROJECT SECRET BODY\nUse references/check.md",
    baseDir: await realpath(join(f.cwd, ".zpi", "skills", "review")),
  });
  await expect(loader.loadSkill("missing")).rejects.toThrow("not found");
});

it("SDK discovery uses the session-bound root rather than a different tool working directory", async () => {
  const f = await resourceFixture((_, r) => {
    send(r, chunk({ content: "ok" }));
    done(r);
  });
  const nested = join(f.cwd, "nested");
  await mkdir(nested);
  await writeFile(join(f.cwd, "AGENTS.md"), "ROOT RULE");
  await writeFile(join(nested, "AGENTS.md"), "NESTED RULE");
  await writeSkill(join(f.cwd, ".agents", "skills"), "root", "Root skill");
  await writeSkill(join(nested, ".agents", "skills"), "nested", "Nested skill");
  const { session } = await createAgentSession({
    cwd: nested,
    homeDir: join(f.dir, "home"),
    agentDir: f.agentDir,
    modelRuntime: f.runtime,
    sessionManager: f.manager,
  });
  cleanup.push(async () => {
    await session.abort();
    session.dispose();
  });
  expect(session.systemPrompt).toContain("ROOT RULE");
  expect(session.systemPrompt).not.toContain("NESTED RULE");
  expect(session.listSkills().skills.map((s) => s.name)).toEqual(["root"]);
});

it.each(["plain", "linked", "missing"])(
  "sends %s skill references unchanged without loading their body",
  async (kind) => {
    const f = await resourceFixture((_, r) => {
      send(r, chunk({ content: "ok" }));
      done(r);
    });
    const root = join(f.cwd, ".zpi", "skills");
    await writeSkill(root, "review", "Review", "BODY ON DEMAND");
    const name = kind === "missing" ? "missing" : "review";
    const reference =
      kind === "plain" ? `$${name}` : buildMentionMarkdown(`$${name}`, join(root, name, "SKILL.md"));
    const text = `  ${reference}\ncheck sources  `;
    await f.session.submit(text);
    expect(f.server.requests[0].messages).toContainEqual(
      expect.objectContaining({ role: "user", content: text }),
    );
    const request = JSON.stringify(f.server.requests[0]);
    expect(request).toContain("<available_skills>");
    expect(request).toContain(join(root, "review", "SKILL.md"));
    expect(request).not.toContain("BODY ON DEMAND");
    expect(f.server.requestHeaders[0].authorization).toBeUndefined();
    expect(f.server.requests).toHaveLength(1);
  },
);

it("loads a referenced skill only after the model calls read", async () => {
  let path = "";
  const f = await resourceFixture((_, r, index) => {
    if (index === 0) {
      send(
        r,
        chunk({
          tool_calls: [
            {
              index: 0,
              id: "read-skill",
              type: "function",
              function: { name: "read", arguments: JSON.stringify({ path }) },
            },
          ],
        }),
      );
      done(r, "tool_calls");
    } else {
      send(r, chunk({ content: "ok" }));
      done(r);
    }
  });
  const root = join(f.cwd, ".zpi", "skills");
  await writeSkill(root, "review", "Review", "BODY ON DEMAND");
  path = join(root, "review", "SKILL.md");
  const text = `${buildMentionMarkdown("$review", path)} check sources`;
  await f.session.submit(text);
  expect(f.server.requests).toHaveLength(2);
  expect(f.server.requests[0].messages).toContainEqual(
    expect.objectContaining({ role: "user", content: text }),
  );
  expect(JSON.stringify(f.server.requests[0])).not.toContain("BODY ON DEMAND");
  expect(f.server.requests[1].messages).toContainEqual(
    expect.objectContaining({ role: "tool", content: expect.stringContaining("BODY ON DEMAND") }),
  );
});

it("unknown dollar-prefixed text is sent unchanged without expanding a skill", async () => {
  const f = await resourceFixture((_, r) => {
    send(r, chunk({ content: "ok" }));
    done(r);
  });
  await writeSkill(join(f.cwd, ".zpi", "skills"), "review", "Review", "BODY ON DEMAND");
  const text = "  $100 is the price\n$review is mentioned later  ";
  await f.session.submit(text);
  expect(f.server.requests[0].messages).toContainEqual(
    expect.objectContaining({ role: "user", content: text }),
  );
  expect(JSON.stringify(f.server.requests[0])).not.toContain("BODY ON DEMAND");
});
