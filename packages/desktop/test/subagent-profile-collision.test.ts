import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { SubagentProfiles } from "../src/main/plugins/subagents/profiles.ts";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
const config = {
  name: "alpha",
  description: "Review",
  systemPrompt: "New prompt",
  color: "blue" as const,
  injectAgentsMd: true,
};
it.each([false, true])(
  "refuses an occupied profile filename for create/rename (rename=%s)",
  async (rename) => {
    for (const occupied of [
      "---\nname: bravo\ndescription: Existing\n---\nOriginal prompt\n",
      "invalid YAML profile",
    ]) {
      const root = await mkdtemp(join(tmpdir(), "zpi-profile-collision-"));
      directories.push(root);
      const dir = join(root, "agents");
      await mkdir(dir);
      await writeFile(join(dir, "alpha.md"), occupied);
      const source = "---\nname: delta\ndescription: Source\n---\nSource prompt\n";
      if (rename) await writeFile(join(dir, "charlie.md"), source);
      const profiles = new SubagentProfiles(root);
      expect(() => profiles.save(config, "user", rename ? "user:charlie" : undefined)).toThrow("文件已存在");
      expect(await readFile(join(dir, "alpha.md"), "utf8")).toBe(occupied);
      if (rename) expect(await readFile(join(dir, "charlie.md"), "utf8")).toBe(source);
      expect((await readdir(dir)).some((file) => file.endsWith(".tmp"))).toBe(false);
    }
  },
);
it("allows same-file edits and free-destination renames while preserving disabled state", async () => {
  const root = await mkdtemp(join(tmpdir(), "zpi-profile-edit-"));
  directories.push(root);
  const profiles = new SubagentProfiles(root);
  profiles.save(config, "user");
  profiles.enable("user:alpha", false);
  profiles.save({ ...config, systemPrompt: "Edited" }, "user", "user:alpha");
  expect(await readFile(join(root, "agents", "alpha.md"), "utf8")).toContain("Edited");
  const next = profiles.save({ ...config, name: "bravo" }, "user", "user:alpha");
  expect(next.agents.find((agent) => agent.id === "user:bravo")?.enabled).toBe(false);
  expect(await readdir(join(root, "agents"))).toEqual(["bravo.md"]);
});
