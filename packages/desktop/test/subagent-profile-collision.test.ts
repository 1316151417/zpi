import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { SubagentProfiles } from "../src/main/plugins/subagents/profiles.ts";
import { StateStore } from "../src/main/state-store.ts";

const directories: string[] = [];
const stores: StateStore[] = [];
function state(root: string) {
  const store = new StateStore(join(root, "state.sqlite"));
  stores.push(store);
  return store;
}
afterEach(async () => {
  for (const store of stores.splice(0)) store.close();
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
      const profiles = new SubagentProfiles(root, state(root));
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
  const profiles = new SubagentProfiles(root, state(root));
  profiles.save(config, "user");
  profiles.enable("user:alpha", false);
  profiles.save({ ...config, systemPrompt: "Edited" }, "user", "user:alpha");
  expect(await readFile(join(root, "agents", "alpha.md"), "utf8")).toContain("Edited");
  const next = profiles.save({ ...config, name: "bravo" }, "user", "user:alpha");
  expect(next.agents.find((agent) => agent.id === "user:bravo")?.enabled).toBe(false);
  expect(await readdir(join(root, "agents"))).toEqual(["bravo.md"]);
});

it("stores disabled profiles and built-in model overrides only in SQLite across reopen", async () => {
  const root = await mkdtemp(join(tmpdir(), "zpi-profile-state-"));
  directories.push(root);
  const store = state(root);
  const profiles = new SubagentProfiles(root, store);
  profiles.save(config, "user");
  const original = await readFile(join(root, "agents", "alpha.md"), "utf8");
  profiles.enable("user:alpha", false);
  const builtIn = profiles.list().agents.find((agent) => agent.id === "built-in:Explore");
  if (!builtIn) throw new Error("missing built-in profile");
  const selection = { provider: "provider", modelId: "model", reasoning: "high" };
  profiles.save({ ...builtIn, modelSelection: selection }, "user", builtIn.id);
  expect(await readFile(join(root, "agents", "alpha.md"), "utf8")).toBe(original);
  expect(await readdir(root)).not.toContain("agents-state.json");
  // An obsolete file cannot override or repair current database state.
  await writeFile(join(root, "agents-state.json"), "broken legacy content");
  const reopened = new SubagentProfiles(root, state(root));
  expect(reopened.list().agents.find((agent) => agent.id === "user:alpha")?.enabled).toBe(false);
  expect(reopened.list().agents.find((agent) => agent.id === builtIn.id)?.modelSelection).toEqual(selection);
  reopened.save({ ...builtIn, modelSelection: undefined }, "user", builtIn.id);
  expect(
    new SubagentProfiles(root, store).list().agents.find((agent) => agent.id === builtIn.id)?.modelSelection,
  ).toBeUndefined();
});

it("rejects invalid authoritative profile state instead of falling back to a legacy file", async () => {
  const root = await mkdtemp(join(tmpdir(), "zpi-profile-invalid-"));
  directories.push(root);
  const store = state(root);
  await writeFile(join(root, "agents-state.json"), JSON.stringify({ disabled: [], overrides: {} }));
  store.setSetting("subagentProfiles", { disabled: [], overrides: { "built-in:Explore": { provider: 42 } } });
  expect(() => new SubagentProfiles(root, store)).toThrow("状态无效");
});
