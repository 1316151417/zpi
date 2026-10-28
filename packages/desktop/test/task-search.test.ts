import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { chunk, done, send } from "../../../tests/fake-server.ts";
import { HistoryIndex } from "../src/main/history-index.ts";
import { SessionHost } from "../src/main/session-host.ts";
import { resolveSearchScope, taskSearchRows } from "../src/renderer/task-search-model.ts";
import { buildTaskSearchSnippets } from "../src/shared/task-search.ts";
import { seedHistory } from "./helpers/history-fixture.ts";
import { fixture as hostFixture } from "./helpers/host-fixture.ts";
import { cleanup, setup } from "./helpers/session-fixture.ts";

afterEach(() => vi.restoreAllMocks());

it("finds non-ASCII body text with the same case conversion as titles and snippets", async () => {
  const f = await hostFixture((_, response) => {
    send(response, chunk({ content: "Äpfel ÉCOLE ΟΣ İx" }));
    done(response);
  });
  const session = await f.host.createSession(f.a.id);
  const run = await f.host.startRun({ sessionId: session.id, text: "Fruit glossary" });
  await f.host.activeRuns.get(session.id)?.done;
  f.host.renameSession(session.id, "Fruit glossary");
  for (const query of ["pfel", "Äpfel", "äpfel", "école", "ΟΣ", "ος", "x"]) {
    expect(f.host.searchTasks(query)).toMatchObject([{ id: session.id, snippets: [{ runId: run.runId }] }]);
  }
});

it("maps expanded lowercase matches and context back to the original run offsets", () => {
  expect(
    buildTaskSearchSnippets(
      [
        { runId: "first", text: "İ" },
        { runId: "second", text: "x" },
      ],
      "x",
    ),
  ).toMatchObject([{ runId: "second", matchBefore: "", matchAfter: "" }]);
  expect(buildTaskSearchSnippets([{ runId: "r", text: "İx" }], "x")).toMatchObject([
    { runId: "r", matchBefore: "İ", matchAfter: "" },
  ]);
  expect(buildTaskSearchSnippets([{ runId: "r", text: "aİz" }], "i")).toMatchObject([
    { runId: "r", matchBefore: "a", matchAfter: "z" },
  ]);
});

it("reads matching history segments lazily and stops after four snippets", () => {
  let visited = 0;
  function* segments() {
    for (let i = 0; i < 80; i++) {
      visited++;
      yield { runId: `run-${i}`, text: `${"x".repeat(210_000)} Needle ${i}` };
    }
  }
  const snippets = buildTaskSearchSnippets(segments(), "needle");
  expect(visited).toBe(4);
  expect(snippets.map((snippet) => snippet.runId)).toEqual(["run-0", "run-1", "run-2", "run-3"]);
  expect(snippets.every((snippet) => snippet.text.length <= 140)).toBe(true);
});

it("keeps original Unicode match context beyond the old index limit without crossing entries", () => {
  const prefix = `İ${"x".repeat(210_000)} `;
  expect(buildTaskSearchSnippets([{ runId: "long", text: `${prefix}ÄPFEL İx suffix` }], "i")).toMatchObject([
    { runId: "long", matchBefore: "", matchAfter: "x".repeat(72) },
    { runId: "long", matchBefore: `${"x".repeat(13)} ÄPFEL `, matchAfter: "x suffix" },
  ]);
  expect(
    buildTaskSearchSnippets(
      [
        { runId: "first", text: "before needle" },
        { runId: "second", text: "after needle" },
      ],
      "needle",
    ),
  ).toMatchObject([
    { runId: "first", matchBefore: "before ", matchAfter: "" },
    { runId: "second", matchBefore: "after ", matchAfter: "" },
  ]);
});

describe("task list search", () => {
  it("finds unopened history, rebuilds old indexes, excludes drafts/children/archives and ignores tools/thinking", async () => {
    const f = await setup();
    const seed = seedHistory(f.settings.state, f.dir, f.cwd, 30);
    await f.host.close();
    const host = new SessionHost(f.dir, f.settings, join(f.dir, "resources"), f.cwd);
    await host.init();
    cleanup.push(() => host.close());
    expect(
      f.settings.state.db.prepare("SELECT count(*) AS n FROM transcript_search").get()?.n,
    ).toBeGreaterThan(0);
    expect(host.searchTasks("完整第一条用户上下文")).toEqual([]); // The visible run input owns user text.
    expect(host.searchTasks("用户上下文 0")[0]).toMatchObject({
      id: seed.id,
      snippets: [{ runId: "run-0" }],
    });
    expect(host.searchTasks("最终回复 0")[0].snippets[0].runId).toBe("run-0");
    expect(host.searchTasks("工具结果")).toEqual([]);
    expect(host.searchTasks("思考")).toEqual([]);
    await host.createSession(null);
    const searchText = vi.spyOn(HistoryIndex.prototype, "searchTextFor");
    expect(host.searchTasks("  ")).toMatchObject([{ id: seed.id, snippets: [] }]);
    expect(searchText).not.toHaveBeenCalled();
    host.renameSession(seed.id, "Needle task");
    expect(host.searchTasks("  NEEDLE  ")[0]).toMatchObject({ id: seed.id, title: "Needle task" });
    await host.archiveSession(seed.id);
    expect(host.searchTasks("needle")).toEqual([]);
    host.restoreSession(seed.id);
    expect(host.searchTasks("needle")[0].id).toBe(seed.id);
    await host.close();
    f.settings.state.db.exec("DELETE FROM transcript_state");
    const reopened = new SessionHost(f.dir, f.settings, join(f.dir, "resources"), f.cwd);
    await reopened.init();
    cleanup.push(() => reopened.close());
    expect(reopened.searchTasks("最终回复 0")[0].id).toBe(seed.id);
    expect(() => reopened.searchTasks("x".repeat(501))).toThrow("任务查询无效");
  });

  it("stops searching history after the 80 most recent matches", async () => {
    const f = await setup();
    const seed = (updatedAt: number, calls: number) => {
      const { id } = seedHistory(f.settings.state, f.dir, f.cwd, calls);
      const task = f.settings.state.getTask(id);
      if (!task) throw new Error("Missing seeded task");
      f.settings.state.upsertTask({ ...task, updatedAt });
      return id;
    };
    const ids = Array.from({ length: 82 }, (_, i) => seed(i, 1));
    // A newer nonmatch must not consume a result slot.
    seed(100, 0);
    await f.host.close();
    const host = new SessionHost(f.dir, f.settings, join(f.dir, "resources"), f.cwd);
    await host.init();
    cleanup.push(() => host.close());
    const hasText = vi.spyOn(HistoryIndex.prototype, "hasSearchText");
    const searchText = vi.spyOn(HistoryIndex.prototype, "searchTextFor");
    const results = host.searchTasks("最终回复");
    expect(results.map((task) => task.id)).toEqual(ids.reverse().slice(0, 80));
    expect(results.every((task) => task.snippets[0]?.runId === "run-0")).toBe(true);
    expect(hasText).toHaveBeenCalledTimes(81);
    expect(searchText).toHaveBeenCalledTimes(80);
  });

  it("searches across projects, sorts by activity and discovers files beyond mention suggestions", async () => {
    const f = await setup();
    const other = join(f.dir, "other");
    await mkdir(other);
    const project = await f.host.addProject(other);
    const first = seedHistory(f.settings.state, f.dir, f.cwd, 2);
    const second = seedHistory(f.settings.state, f.dir, other, 1, { projectId: project.id });
    await f.host.close();
    const host = new SessionHost(f.dir, f.settings, join(f.dir, "resources"), f.cwd);
    await host.init();
    cleanup.push(() => host.close());
    expect(host.searchTasks("最终回复").map((task) => task.id)).toEqual([second.id, first.id]);
    expect(host.searchTasks("", f.cwd).map((task) => task.id)).toEqual([first.id]);
    await Promise.all(Array.from({ length: 25 }, (_, i) => writeFile(join(f.cwd, `source-${i}.ts`), "")));
    const files = (
      await host.searchWorkspaceFiles(first.id, {
        query: "source-",
        requestId: "task-search",
        filesOnly: true,
      })
    ).entries;
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
