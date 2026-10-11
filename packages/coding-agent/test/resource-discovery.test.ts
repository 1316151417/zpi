import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { FileResourceLoader } from "../src/index.ts";
import { skill } from "./helpers/resource-fixture.ts";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "zpi-discovery-"));
  directories.push(dir);
  const homeDir = join(dir, "home");
  const projectDir = join(dir, "project");
  await mkdir(homeDir);
  await mkdir(projectDir);
  return { dir, homeDir, projectDir };
}
async function instructions(path: string, text: string) {
  await mkdir(path, { recursive: true });
  await writeFile(join(path, "AGENTS.md"), text);
}

test("merges only the four fixed instruction files in user-to-project order", async () => {
  const f = await fixture();
  const roots = [
    join(f.homeDir, ".agents"),
    join(f.homeDir, ".zpi"),
    f.projectDir,
    join(f.projectDir, ".zpi"),
  ];
  for (const [index, root] of roots.entries()) await instructions(root, `RULE ${index}`);
  for (const root of [
    f.dir,
    f.homeDir,
    join(f.homeDir, ".zpi", "agent"),
    join(f.projectDir, ".agents"),
    join(f.projectDir, "nested"),
  ]) {
    await instructions(root, "IGNORED RULE");
  }
  const loader = new FileResourceLoader(f);
  await loader.reload();
  const prompt = loader.getAppendSystemPrompt().join("\n");
  expect(prompt.match(/RULE \d/g)).toEqual(["RULE 0", "RULE 1", "RULE 2", "RULE 3"]);
  expect(prompt).not.toContain("IGNORED RULE");
  expect(loader.getDiagnostics()).toEqual([]);
  const global = new FileResourceLoader({ ...f, projectResources: false });
  await global.reload();
  expect(
    global
      .getAppendSystemPrompt()
      .join("\n")
      .match(/RULE \d/g),
  ).toEqual(["RULE 0", "RULE 1"]);
});

test("same-name skills override in fixed priority order without recursive discovery", async () => {
  const f = await fixture();
  const roots = [
    join(f.homeDir, ".agents", "skills"),
    join(f.homeDir, ".zpi", "skills"),
    join(f.projectDir, ".agents", "skills"),
    join(f.projectDir, ".zpi", "skills"),
  ];
  const loader = new FileResourceLoader(f);
  for (const [index, root] of roots.entries()) {
    await skill(root, "review", `Review ${index}`, `BODY ${index}`);
    await loader.reload();
    expect(loader.listSkills().skills).toMatchObject([{ name: "review", description: `Review ${index}` }]);
    expect(await loader.loadSkill("review")).toMatchObject({ body: `BODY ${index}` });
  }
  for (const root of [
    join(f.dir, ".agents", "skills"),
    join(f.homeDir, ".zpi", "agent", "skills"),
    join(f.projectDir, "nested", ".zpi", "skills"),
    join(roots[3], "category"),
  ]) {
    await skill(root, "ignored", "Ignored skill");
  }
  await loader.reload();
  expect(loader.listSkills().skills).toHaveLength(1);
  expect(loader.listDiscoveredSkills()).toHaveLength(4);
  const winner = loader.listSkills().skills[0];
  expect(
    loader
      .listDiscoveredSkills()
      .slice(0, 3)
      .every((s) => s.overriddenBy === winner.path),
  ).toBe(true);
  const disabled = new FileResourceLoader({ ...f, isSkillEnabled: (path) => path !== winner.path });
  await disabled.reload();
  expect(disabled.listSkills().skills).toEqual([]);
  await expect(disabled.loadSkill("review")).rejects.toThrow("disabled");
});

test("missing fixed paths are optional and unreadable instructions are diagnosed", async () => {
  const f = await fixture();
  const loader = new FileResourceLoader(f);
  await loader.reload();
  expect(loader.getAppendSystemPrompt()).toEqual([]);
  expect(loader.getDiagnostics()).toEqual([]);
  const path = join(f.projectDir, ".zpi", "AGENTS.md");
  await mkdir(path, { recursive: true });
  await loader.reload();
  expect(loader.getDiagnostics()).toEqual([{ path, message: expect.stringContaining("EISDIR") }]);
});
