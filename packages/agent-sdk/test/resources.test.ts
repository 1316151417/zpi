import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { type PluginSnapshot, SkillCatalog } from "zpi-coding-agent";
import { importLocalPlugin } from "zpi-plugin-compat";
import { pluginAgents, SdkResources } from "../src/resources.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "zpi-sdk-resources-"));
  roots.push(root);
  return root;
}

test("SDK and core skill discovery read the same BOM and spaced-frontmatter syntax", async () => {
  const root = await fixture();
  const markdown =
    "\uFEFF--- \t\r\nname: review\r\ndescription: Review changes\r\n--- \t\r\n\r\nReview the selected diff.\r\n";
  for (const path of [join(root, ".claude", "skills", "review"), join(root, ".agents", "skills", "review")]) {
    await mkdir(path, { recursive: true });
    await writeFile(join(path, "SKILL.md"), markdown);
  }
  const sdk = new SdkResources({ settingSources: ["project"] }, root);
  const core = new SkillCatalog({ projectDir: root, homeDir: join(root, "home") });
  await Promise.all([sdk.reload(), core.reload()]);
  expect(await sdk.loadSkill("review")).toMatchObject({
    description: "Review changes",
    body: "Review the selected diff.",
  });
  expect(await core.loadSkill("review")).toMatchObject({
    description: "Review changes",
    body: "Review the selected diff.",
  });
  expect(core.listSkills().diagnostics).toEqual([]);
});

test("core discovery still bounds frontmatter at 64 KiB without reading a large skill body", async () => {
  const root = await fixture();
  for (const [name, markdown] of [
    ["oversized", `---\ndescription: Review\nnotes: ${"x".repeat(65536)}\n---\nBody`],
    ["large-body", `\uFEFF--- \t\ndescription: Review\n---\t \n${"body".repeat(512 * 1024)}`],
  ]) {
    const path = join(root, ".agents", "skills", name);
    await mkdir(path, { recursive: true });
    await writeFile(join(path, "SKILL.md"), markdown);
  }
  const catalog = new SkillCatalog({ projectDir: root, homeDir: join(root, "home") });
  await catalog.reload();
  expect(catalog.listSkills().skills.map((skill) => skill.name)).toEqual(["large-body"]);
  expect(catalog.listSkills().diagnostics).toEqual([
    expect.objectContaining({ message: expect.stringContaining("limit 64 KiB") }),
  ]);
});

test.each([
  "name: 12\ndescription: Review",
  "name: null\ndescription: Review",
  "name: review\ndescription: 12",
  "name: review\ndescription: ''",
  "- description: List metadata",
])("rejects malformed SDK skill metadata without accepting an invalid name/description: %j", async (yaml) => {
  const root = await fixture(),
    path = join(root, ".claude", "skills", "review");
  await mkdir(path, { recursive: true });
  await writeFile(join(path, "SKILL.md"), `---\n${yaml}\n---\nBody`);
  await expect(new SdkResources({ settingSources: ["project"] }, root).reload()).rejects.toThrow();
});

test("an imported plugin Agent retains BOM and spaced fences and loads through the SDK", async () => {
  const root = await fixture(),
    source = join(root, "source");
  await mkdir(join(source, ".claude-plugin"), { recursive: true });
  await mkdir(join(source, "agents"));
  await writeFile(
    join(source, ".claude-plugin", "plugin.json"),
    JSON.stringify({ name: "review", version: "1" }),
  );
  await writeFile(
    join(source, "agents", "reviewer.md"),
    "\uFEFF--- \t\nname: reviewer\ndescription: Review code\ntools: Read, Bash\n---\t \n\nReview this project.\n",
  );
  const snapshot = await importLocalPlugin(source, join(root, "plugins"));
  expect(pluginAgents(snapshot)).toEqual({
    "review:reviewer": {
      description: "Review code",
      prompt: "Review this project.",
      tools: ["Read", "Bash"],
      disallowedTools: undefined,
      model: undefined,
    },
  });
});

test("plugin Agent still requires frontmatter even when plain plugin commands allow it", () => {
  const snapshot: PluginSnapshot = {
    id: "sample",
    name: "sample",
    version: "1",
    options: { agents: [{ name: "plain", markdown: "Plain prompt" }] },
  };
  expect(() => pluginAgents(snapshot)).toThrow("requires YAML frontmatter");
});
