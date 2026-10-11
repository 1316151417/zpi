import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { piTemplate, SessionManager } from "zpi-coding-agent";
import { repairSessions } from "../../../scripts/repair-sessions.ts";

const directories: string[] = [];
afterEach(async () => {
  for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "zpi-repair-"));
  directories.push(dir);
  const data = join(dir, "ZPI Preview");
  const root = join(data, "agent", "sessions", "_unassigned");
  const manager = SessionManager.create(dir, root, { id: "legacy" });
  manager.appendCustomEntry("ZPI.configuration", {
    template: { ...piTemplate },
    disabledSkillPaths: ["/disabled-skill"],
    askUserQuestion: true,
    fileLinks: false,
  });
  manager.appendCustomEntry("ZPI.run", { phase: "end", runId: "run-1", status: "completed" });
  manager.appendMessage({
    role: "system",
    content: "Original ZPI instructions",
    timestamp: 1,
    sections: { "ZPI.instructions": "Keep ZPI words unchanged", external: "external section" },
  });
  manager.appendMessage({ role: "user", content: "ZPI.run is text, not metadata", timestamp: 2 });
  const path = join(root, "legacy.jsonl");
  const rows = (await readFile(path, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  rows[0].format = "ZPI";
  const original = `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
  await writeFile(path, original);
  await writeFile(`${path}.index.json`, "old index");
  await writeFile(join(data, "settings.json"), "settings must not change");
  return { dir, data, root, path, original };
}

it("backs up and migrates legacy metadata while preserving messages, IDs and existing capabilities", async () => {
  const f = await fixture();
  expect(await repairSessions(f.data, true)).toMatchObject({ changed: 1, backup: null });
  expect(await readFile(f.path, "utf8")).toBe(f.original);
  expect(await readdir(f.dir)).toEqual(["ZPI Preview"]);
  const result = await repairSessions(f.data);
  expect(result).toMatchObject({ scanned: 1, changed: 1 });
  if (!result.backup) throw new Error("Expected a backup directory");
  expect(
    await readFile(join(result.backup, "agent", "sessions", "_unassigned", "legacy.jsonl"), "utf8"),
  ).toBe(f.original);
  expect(
    await readFile(
      join(result.backup, "agent", "sessions", "_unassigned", "legacy.jsonl.index.json"),
      "utf8",
    ),
  ).toBe("old index");
  await expect(readFile(`${f.path}.index.json`)).rejects.toMatchObject({ code: "ENOENT" });
  const manager = SessionManager.open(f.path);
  expect(manager.getEntries()[0]).toMatchObject({
    customType: "zpi.configuration",
    data: {
      askUserQuestion: true,
      toolBatching: true,
      fileLinks: false,
      disabledSkillPaths: ["/disabled-skill"],
    },
  });
  expect(manager.getEntries()[1]).toMatchObject({ customType: "zpi.run" });
  expect(manager.getEntries()[2]).toMatchObject({
    message: {
      content: "Original ZPI instructions",
      sections: { "zpi.instructions": "Keep ZPI words unchanged", external: "external section" },
    },
  });
  expect(manager.getEntries()[3]).toMatchObject({ message: { content: "ZPI.run is text, not metadata" } });
  const before = f.original
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(manager.getEntries().map(({ id, parentId, timestamp }) => ({ id, parentId, timestamp }))).toEqual(
    before.slice(1).map(({ id, parentId, timestamp }) => ({ id, parentId, timestamp })),
  );
  expect(await readFile(join(f.data, "settings.json"), "utf8")).toBe("settings must not change");
  const saved = await readFile(f.path, "utf8");
  expect(await repairSessions(f.data)).toEqual({ scanned: 1, changed: 0, backup: null });
  expect(await readFile(f.path, "utf8")).toBe(saved);
  expect(await readdir(f.dir)).toHaveLength(2);
});

it("rejects corrupt data before writing any session or creating a backup", async () => {
  const f = await fixture();
  await writeFile(join(f.root, "broken.jsonl"), "not json\n");
  await expect(repairSessions(f.data)).rejects.toThrow("尚未修改任何会话");
  expect(await readFile(f.path, "utf8")).toBe(f.original);
  expect(await readFile(`${f.path}.index.json`, "utf8")).toBe("old index");
  expect(await readdir(f.dir)).toEqual(["ZPI Preview"]);
});

it.skipIf(process.platform === "win32")(
  "refuses to migrate while the application lock belongs to a live process",
  async () => {
    const f = await fixture();
    await mkdir(f.data, { recursive: true });
    await symlink(`${hostname()}-${process.pid}`, join(f.data, "SingletonLock"));
    await expect(repairSessions(f.data)).rejects.toThrow("请先退出");
    expect(await readFile(f.path, "utf8")).toBe(f.original);
  },
);
