import { execFileSync } from "node:child_process";
import { link, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { parseShortMemory, readShortMemory } from "../src/main/memory/short-memory.ts";

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "zpi-short-memory-"));
  temporary.push(root);
  const homeDir = join(root, "home");
  const workspace = join(root, "workspace");
  await Promise.all([mkdir(join(homeDir, ".zpi"), { recursive: true }), mkdir(workspace)]);
  return { homeDir, workspace, userPath: join(homeDir, ".zpi", "MEMORY.md") };
}

test("parses stable IDs, optional headings, blank lines, BOM and normalized continuation bodies", () => {
  const parsed = parseShortMemory(
    "\uFEFF# Memory\r\n\r\n- [language] 中文 😀  \r\n  continued\r\n\tline\r\n\r\n- [review_2] review",
  );
  expect(parsed.entries).toEqual([
    { id: "language", body: "中文 😀\ncontinued\nline" },
    { id: "review_2", body: "review" },
  ]);
  expect(parsed.characters).toBe([...(parsed.entries[0].body + parsed.entries[1].body)].length);
  expect(parsed.diagnostics).toEqual([]);
  expect(parsed.injected).toBe("- [language] 中文 😀\n  continued\n  line\n- [review_2] review");
  expect(parseShortMemory("").injected).toBe("");
  expect(parseShortMemory("# Memory\n\n").diagnostics).toEqual([]);
});

test.each([
  ["unmarked prose", "Plain prose"],
  ["bullet without an ID", "- A preference"],
  ["empty body", "- [empty] "],
  ["duplicate ID", "- [same] first\n- [same] second"],
  ["invalid ID", "- [not valid] body"],
  ["overlong ID", `- [${"x".repeat(65)}] body`],
  ["ID starts with punctuation", "- [-name] body"],
  ["orphan continuation", "  orphan"],
  ["insufficient indentation", "- [id] body\n continuation"],
  ["second heading", "# Memory\n# Memory"],
  ["heading after entries", "- [id] body\n# Memory"],
  ["unsupported heading", "## Memory"],
])("rejects the whole file for %s and reports diagnostics", (_, text) => {
  const parsed = parseShortMemory(text);
  expect(parsed.injected).toBe("");
  expect(parsed.diagnostics[0]).toContain("行");
  expect(parsed.diagnostics.at(-1)).toContain("磁盘内容未修改");
});

test("enforces both limits including astral code points and multiline body text", () => {
  const twenty = Array.from({ length: 20 }, (_, i) => `- [entry-${i}] ${"😀".repeat(100)}`).join("\n");
  expect(parseShortMemory(twenty)).toMatchObject({ characters: 2000, diagnostics: [], injected: twenty });
  expect(parseShortMemory(`${twenty}\n- [overflow] x`).injected).toBe("");
  expect(parseShortMemory(`${twenty}x`).diagnostics).toContain(
    "记忆正文 2001 个 Unicode 字符超过上限 2000。",
  );
  expect(parseShortMemory(`- [long] ${"a".repeat(2001)}`).injected).toBe("");
  expect(parseShortMemory(`- [lines] ${"a".repeat(1999)}\n  b`).characters).toBe(2001);
  expect(parseShortMemory(`- [lines] ${"a".repeat(1999)}\n  b`).injected).toBe("");
  const shortEntries = Array.from({ length: 21 }, (_, i) => `- [entry-${i}] x`).join("\n");
  expect(parseShortMemory(shortEntries).diagnostics).toContain("记忆条数 21 超过上限 20。");
});

test("missing files remain absent, with user-only scope when no workspace is bound", async () => {
  const f = await fixture();
  const result = await readShortMemory({ homeDir: f.homeDir });
  expect(result.files).toEqual([
    { path: f.userPath, scope: "user", exists: false, count: 0, characters: 0, diagnostics: [] },
  ]);
  expect(result.diagnostics).toEqual([]);
  expect(result.instructions.join("\n")).toContain("no project memory file");
  await expect(stat(f.userPath)).rejects.toMatchObject({ code: "ENOENT" });
});

test("loads both scopes from the bound workspace without changing existing files", async () => {
  const f = await fixture();
  const user = "# Memory\n- [language] 用户偏好";
  const project = "# Memory\n- [constraint] 项目约束";
  await Promise.all([
    writeFile(f.userPath, user),
    writeFile(join(f.workspace, "MEMORY.md"), project),
    mkdir(join(f.workspace, "nested")),
  ]);
  await writeFile(join(f.workspace, "nested", "MEMORY.md"), "- [wrong] 不应加载");
  const result = await readShortMemory(f);
  const injected = result.instructions.filter((part) => part.startsWith("<short_memory"));
  expect(injected).toHaveLength(2);
  expect(injected[0]).toContain('scope="user"');
  expect(injected[1]).toContain('scope="project"');
  expect(injected[1]).toContain(`workspace ${JSON.stringify(f.workspace)}`);
  expect(result.instructions.join("\n")).not.toContain("不应加载");
  expect(await readFile(f.userPath, "utf8")).toBe(user);
  expect(await readFile(join(f.workspace, "MEMORY.md"), "utf8")).toBe(project);
});

test("uses worktree roots independently and refreshes only on a requested new snapshot", async () => {
  const f = await fixture();
  const worktree = join(f.workspace, "worktree");
  await mkdir(worktree);
  await writeFile(join(f.workspace, "MEMORY.md"), "- [scope] original checkout");
  await writeFile(join(worktree, "MEMORY.md"), "- [scope] worktree checkout");
  const first = await readShortMemory({ homeDir: f.homeDir, workspace: worktree });
  expect(first.instructions.join("\n")).toContain("worktree checkout");
  expect(first.instructions.join("\n")).not.toContain("original checkout");
  await writeFile(join(worktree, "MEMORY.md"), "- [scope] updated checkout");
  expect(first.instructions.join("\n")).not.toContain("updated checkout");
  const second = await readShortMemory({ homeDir: f.homeDir, workspace: worktree });
  expect(second.instructions.join("\n")).toContain("updated checkout");
});

test.each(["symlink", "hard link"])("deduplicates the same user/project file through a %s", async (kind) => {
  const f = await fixture();
  await writeFile(f.userPath, "- [same] only once");
  await (kind === "symlink" ? symlink : link)(f.userPath, join(f.workspace, "MEMORY.md"));
  const result = await readShortMemory(f);
  expect(result.files.map((file) => [file.scope, file.count, file.characters])).toEqual([
    ["user", 1, 9],
    ["project", 1, 9],
  ]);
  expect(result.instructions.join("\n").match(/only once/g)).toHaveLength(1);
  expect(result.diagnostics).toEqual([]);
});

test("does not inject malformed UTF-8 as silently replaced memory text", async () => {
  const f = await fixture();
  const bytes = Buffer.concat([Buffer.from("- [bad] "), Buffer.from([0xff])]);
  await writeFile(f.userPath, bytes);
  const result = await readShortMemory(f);
  expect(result.files[0].diagnostics[0]).toContain("无法加载短记忆");
  expect(result.instructions.filter((part) => part.startsWith("<short_memory"))).toHaveLength(0);
  expect(await readFile(f.userPath)).toEqual(bytes);
});

test("retains all format diagnostics in status without allowing invalid files to flood model context", async () => {
  const f = await fixture();
  await writeFile(f.userPath, "invalid line\n".repeat(5000));
  const result = await readShortMemory(f);
  expect(result.diagnostics).toHaveLength(5001);
  const injected = result.instructions.join("\n");
  expect(injected).toContain("5001 项诊断");
  expect(injected.length).toBeLessThan(5000);
  expect(injected).not.toContain("第 5000 行");
});

test("invalid or oversized files retain disk contents and expose diagnostics while valid scope loads", async () => {
  const f = await fixture();
  const source = `- [too-long] ${"x".repeat(2001)}`;
  await writeFile(f.userPath, source);
  await writeFile(join(f.workspace, "MEMORY.md"), "- [project] valid");
  const result = await readShortMemory(f);
  expect(result.files[0]).toMatchObject({ exists: true, count: 1, characters: 2001 });
  expect(result.diagnostics).toContainEqual({
    path: f.userPath,
    message: "记忆正文 2001 个 Unicode 字符超过上限 2000。",
  });
  expect(result.instructions.join("\n")).not.toContain(source);
  expect(result.instructions.join("\n")).toContain("Short-memory loading diagnostics");
  expect(result.instructions.join("\n")).toContain("- [project] valid");
  expect(await readFile(f.userPath, "utf8")).toBe(source);
});

test("reports non-file paths without attempting to read them", async () => {
  const f = await fixture();
  await mkdir(f.userPath);
  const result = await readShortMemory(f);
  expect(result.files[0].exists).toBe(true);
  expect(result.files[0].diagnostics[0]).toContain("普通文件");
  expect(result.instructions.filter((part) => part.startsWith("<short_memory"))).toHaveLength(0);
});

test("rejects files above 64 KiB before parsing and preserves every byte", async () => {
  const f = await fixture();
  const source = " ".repeat(64 * 1024 + 1);
  await writeFile(f.userPath, source);
  const result = await readShortMemory(f);
  expect(result.files[0]).toMatchObject({ exists: true, count: 0, characters: 0 });
  expect(result.files[0].diagnostics[0]).toContain("超过 64 KiB 读取上限");
  expect(result.files[0].diagnostics[0]).toContain("未统计条数与正文");
  expect(result.instructions.filter((part) => part.startsWith("<short_memory"))).toHaveLength(0);
  expect(await readFile(f.userPath, "utf8")).toBe(source);
});

test.skipIf(process.platform === "win32")("rejects a FIFO without waiting for a writer", async () => {
  const f = await fixture();
  execFileSync("mkfifo", [f.userPath]);
  const result = await readShortMemory(f);
  expect(result.files[0].diagnostics[0]).toContain("普通文件");
  expect((await stat(f.userPath)).isFIFO()).toBe(true);
});

test("maintenance instructions preserve scope, priority, evidence and tool boundaries", async () => {
  const f = await fixture();
  const instructions = (await readShortMemory(f)).instructions.join("\n");
  for (const expected of [
    "Current user requests and AGENTS.md take precedence",
    "explicit short-memory preferences take precedence over long-term inferences",
    "existing read/write/edit tools",
    JSON.stringify(f.userPath),
    JSON.stringify(join(f.workspace, "MEMORY.md")),
    "read its latest contents",
    "background memory outputs are not fresh user evidence",
    "When asked to forget, delete",
    "only after its write succeeds",
    "normal maintenance needs no extra confirmation",
    "external edits and bash writes are not blocked",
    "subagents may use inherited memories but must not automatically maintain",
  ])
    expect(instructions).toContain(expected);
});
