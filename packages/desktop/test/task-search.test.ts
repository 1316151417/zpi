import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { seedHistory } from "../../../tests/history-fixture.ts";
import { SessionHost } from "../src/main/session-host.ts";
import { resolveSearchScope, taskSearchRows } from "../src/renderer/task-search-model.ts";
import { buildTaskSearchSnippets } from "../src/shared/task-search.ts";
import { cleanup, setup } from "./helpers/session-fixture.ts";

describe("task list search", () => {
  it("finds unopened history, rebuilds old indexes, excludes drafts/children/archives and ignores tools/thinking", async () => {
    const f = await setup();
    const seed = seedHistory(f.dir, f.cwd, 30);
    await f.host.close();
    const host = new SessionHost(f.dir, f.settings, join(f.dir, "resources"), f.cwd);
    await host.init();
    cleanup.push(() => host.close());
    const persisted = JSON.parse(await readFile(`${seed.file}.index.json`, "utf8"));
    expect(persisted.searchText.length).toBeGreaterThan(0);
    expect(host.searchTasks("完整第一条用户上下文")).toEqual([]); // The visible run input owns user text.
    expect(host.searchTasks("用户上下文 0")[0]).toMatchObject({
      id: seed.id,
      snippets: [{ runId: "run-0" }],
    });
    expect(host.searchTasks("最终回复 0")[0].snippets[0].runId).toBe("run-0");
    expect(host.searchTasks("工具结果")).toEqual([]);
    expect(host.searchTasks("思考")).toEqual([]);
    host.createSession(null);
    expect(host.searchTasks("").map((task) => task.id)).toEqual([seed.id]);
    host.renameSession(seed.id, "Needle task");
    expect(host.searchTasks("  NEEDLE  ")[0]).toMatchObject({ id: seed.id, title: "Needle task" });
    await host.archiveSession(seed.id);
    expect(host.searchTasks("needle")).toEqual([]);
    host.restoreSession(seed.id);
    expect(host.searchTasks("needle")[0].id).toBe(seed.id);
    await host.close();
    persisted.version = 9;
    delete persisted.searchText;
    await writeFile(`${seed.file}.index.json`, JSON.stringify(persisted));
    const reopened = new SessionHost(f.dir, f.settings, join(f.dir, "resources"), f.cwd);
    await reopened.init();
    cleanup.push(() => reopened.close());
    expect(reopened.searchTasks("最终回复 0")[0].id).toBe(seed.id);
    expect(() => reopened.searchTasks("x".repeat(501))).toThrow("任务查询无效");
  });

  it("searches across projects, sorts by activity and discovers files beyond mention suggestions", async () => {
    const f = await setup();
    const other = join(f.dir, "other");
    await mkdir(other);
    const project = await f.host.addProject(other);
    const first = seedHistory(f.dir, f.cwd, 2);
    const second = seedHistory(f.dir, other, 1, { projectId: project.id });
    await f.host.close();
    const host = new SessionHost(f.dir, f.settings, join(f.dir, "resources"), f.cwd);
    await host.init();
    cleanup.push(() => host.close());
    expect(host.searchTasks("最终回复").map((task) => task.id)).toEqual([second.id, first.id]);
    expect(host.searchTasks("", f.cwd).map((task) => task.id)).toEqual([first.id]);
    await Promise.all(Array.from({ length: 25 }, (_, i) => writeFile(join(f.cwd, `source-${i}.ts`), "")));
    const files = await host.listTaskFiles(first.id);
    expect(files.filter((file) => file.type === "file")).toHaveLength(25);
    expect(files.some((file) => file.name === "source-24.ts")).toBe(true);
  });

  it("keeps four distinct context windows, deduplicates rows and parses the same scope prefixes", () => {
    const segments = [
      { runId: "r", text: Array.from({ length: 8 }, (_, i) => `needle ${i}${"-".repeat(200)}`).join(" ") },
    ];
    const snippets = buildTaskSearchSnippets(segments, "needle");
    expect(snippets).toHaveLength(4);
    expect(snippets.every((snippet) => snippet.text.length <= 140 && snippet.text.includes("needle"))).toBe(
      true,
    );
    expect(buildTaskSearchSnippets(segments, "title")).toEqual([{ text: segments[0].text.slice(0, 140) }]);
    expect(buildTaskSearchSnippets(segments, "")).toEqual([]);
    for (const [prefix, scope] of [
      [">", "commands"],
      ["#", "conversations"],
      ["@", "files"],
    ]) {
      expect(resolveSearchScope(`  ${prefix} needle`)).toEqual({ query: "needle", scope, explicit: true });
    }
    expect(resolveSearchScope(" hello ")).toEqual({ query: "hello", scope: undefined, explicit: false });
    const task = {
      id: "task",
      title: "T",
      cwd: "/tmp",
      projectId: null,
      createdAt: 0,
      updatedAt: 0,
      snippets,
    };
    expect(taskSearchRows([task, task], "needle")).toHaveLength(4);
    expect(taskSearchRows([task, task], "")).toHaveLength(1);
  });
});
