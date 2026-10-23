import { spawnSync } from "node:child_process";
import { closeSync, constants, openSync, writeSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
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
  const prompt = loader.getInstructions().join("\n");
  expect(prompt.match(/RULE \d/g)).toEqual(["RULE 0", "RULE 1", "RULE 2", "RULE 3"]);
  expect(prompt).not.toContain("IGNORED RULE");
  expect(loader.getDiagnostics()).toEqual([]);
  const global = new FileResourceLoader({ ...f, projectResources: false });
  await global.reload();
  expect(
    global
      .getInstructions()
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
  expect(loader.getInstructions()).toEqual([]);
  expect(loader.getDiagnostics()).toEqual([]);
  const path = join(f.projectDir, ".zpi", "AGENTS.md");
  await mkdir(path, { recursive: true });
  await loader.reload();
  expect(loader.getDiagnostics()).toEqual([{ path, message: expect.stringContaining("regular file") }]);
});

test.skipIf(process.platform === "win32")(
  "rejects non-regular resource files without blocking and still follows file symlinks",
  async () => {
    const f = await fixture();
    const root = join(f.projectDir, ".agents", "skills");
    const pipe = join(root, "pipe", "SKILL.md");
    const instructions = join(f.projectDir, "AGENTS.md");
    const directory = join(root, "directory", "SKILL.md");
    const linked = join(root, "linked", "SKILL.md");
    await mkdir(join(root, "pipe"), { recursive: true });
    await mkdir(directory, { recursive: true });
    await mkdir(join(root, "linked"), { recursive: true });
    const target = join(f.dir, "target.md");
    await writeFile(target, "---\ndescription: linked skill\n---\nBODY");
    await symlink(target, linked);
    expect(spawnSync("mkfifo", [pipe, instructions]).status).toBe(0);
    // Unblock the reader if the guard regresses, so a failed assertion cannot leave a blocked fs handle.
    const release = setInterval(() => {
      for (const path of [pipe, instructions]) {
        let fd: number;
        try {
          fd = openSync(path, constants.O_WRONLY | constants.O_NONBLOCK);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENXIO") continue;
          throw error;
        }
        try {
          writeSync(fd, "---\ndescription: must not load a pipe\n---\n");
        } finally {
          closeSync(fd);
        }
      }
    }, 50);
    try {
      const loader = new FileResourceLoader(f);
      await loader.reload();
      expect(loader.listSkills().skills.map((skill) => skill.name)).toEqual(["linked"]);
      expect(loader.getDiagnostics()).toEqual(
        expect.arrayContaining(
          [pipe, directory, instructions].map((path) => ({
            path,
            message: expect.stringContaining("regular file"),
          })),
        ),
      );
    } finally {
      clearInterval(release);
    }
  },
);
