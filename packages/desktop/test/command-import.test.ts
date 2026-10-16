import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { COMMAND_IMPORT_SOURCES, CommandImportService } from "../src/main/command-import.ts";
import { CustomCommandsStore } from "../src/main/custom-commands.ts";
import type { CommandImportDiscovery, CommandImportMode } from "../src/shared/command-import.ts";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, link: vi.fn(actual.link), symlink: vi.fn(actual.symlink) };
});

const roots: string[] = [];
afterEach(async () => {
  vi.clearAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture(project = false, platform?: NodeJS.Platform) {
  const root = await mkdtemp(join(tmpdir(), "zpi-command-import-"));
  roots.push(root);
  const home = join(root, "home");
  const workspace = join(root, "project");
  await Promise.all([mkdir(home), mkdir(workspace)]);
  const target = join(project ? workspace : home, ".zpi", "commands");
  const service = new CommandImportService({
    homeDirectory: home,
    targetDirectory: target,
    ...(project ? { workspaceDirectory: workspace } : {}),
    ...(platform ? { platform } : {}),
  });
  const put = async (relative: string, content = "Prompt") => {
    const path = join(home, relative);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
    return path;
  };
  return { root, home, workspace, target, service, put };
}
function request(discovery: CommandImportDiscovery, mode: CommandImportMode = "copy") {
  return {
    scanId: discovery.scanId,
    mode,
    selections: discovery.sources.flatMap((source) =>
      source.commands.map(({ id, revision }) => ({ id, revision })),
    ),
  };
}

describe("explicit command source discovery", () => {
  it("performs no constructor scan or target creation, and only scans the 15 ZCode command roots", async () => {
    const { home, target, service, put } = await fixture();
    expect(await readdir(home)).toEqual([]);
    await expect(lstat(target)).rejects.toHaveProperty("code", "ENOENT");
    for (const source of COMMAND_IMPORT_SOURCES) await put(`${source.path}/test.md`);
    for (const other of [
      ".agents/commands",
      ".zcode/commands",
      ".trae-cn/commands",
      ".codex/prompts",
      ".claude/skills",
    ]) {
      await put(`${other}/ignored.md`);
    }
    const discovery = await service.discover();
    expect(discovery.sources).toHaveLength(15);
    expect(discovery.sources.map((source) => source.label)).toEqual(
      COMMAND_IMPORT_SOURCES.map((source) => source.label),
    );
    expect(
      discovery.sources.flatMap((source) => source.commands).every((item) => item.name === "/test"),
    ).toBe(true);
    await expect(lstat(target)).rejects.toHaveProperty("code", "ENOENT");
  });

  it("reads only Markdown metadata, preserves nested names, and ignores hidden files and directory links", async () => {
    const { root, home, service, put } = await fixture();
    await put(
      ".claude/commands/tools/review.MD",
      "---\ndescription: Review changes\nargument-hint: <path>\n---\n\n!`touch NEVER_RUN`\n$ARGUMENTS",
    );
    await put(".claude/commands/.hidden.md");
    await put(".claude/commands/.hidden/private.md");
    await put(".claude/commands/readme.txt");
    const outside = join(root, "outside");
    await mkdir(outside);
    await writeFile(join(outside, "secret.md"), "not a command");
    await symlink(outside, join(home, ".claude", "commands", "linked-dir"), "dir");
    await symlink(join(outside, "secret.md"), join(home, ".claude", "commands", "linked.md"), "file");
    const discovery = await service.discover();
    expect(discovery.sources[0].commands).toHaveLength(1);
    expect(discovery.sources[0].commands[0]).toMatchObject({
      name: "/tools/review",
      description: "Review changes",
      argumentHint: "<path>",
      relativePath: "tools/review.MD",
    });
    expect(await readdir(root)).not.toContain("NEVER_RUN");
  });

  it("discovers global and project roots separately, deduplicating shared Qoder project paths", async () => {
    const { workspace, target, service, put } = await fixture(true);
    await put(".claude/commands/global.md");
    for (const path of [".claude/commands/local.md", ".qoder/commands/shared.md", "commands/claw.md"]) {
      await mkdir(dirname(join(workspace, path)), { recursive: true });
      await writeFile(join(workspace, path), "Project prompt");
    }
    const discovery = await service.discover();
    expect(discovery).toMatchObject({
      targetDirectory: target,
      targetScope: "project",
      projectAvailable: true,
    });
    expect(discovery.sources.map((source) => [source.id, source.scope])).toEqual([
      ["claudeCode:global", "global"],
      ["claudeCode:project", "project"],
      ["openClaw:project", "project"],
      ["qode:project", "project"],
    ]);
    expect((await service.importSelected(request(discovery))).importedCount).toBe(4);
    expect(await readFile(join(target, "global.md"), "utf8")).toBe("Prompt");
  });

  it("bounds a single explicit scan to 1,000 command candidates", async () => {
    const { service, put } = await fixture();
    await Promise.all(
      Array.from({ length: 1001 }, (_, index) => put(`.claude/commands/command-${index}.md`)),
    );
    const discovery = await service.discover();
    expect(discovery.sources.flatMap((source) => source.commands)).toHaveLength(1000);
    expect(discovery.warnings.join(" ")).toContain("1,000");
  });

  it("rejects unsupported target paths and non-absolute injected roots", async () => {
    const { home, root } = await fixture();
    expect(
      () => new CommandImportService({ homeDirectory: home, targetDirectory: join(root, "other") }),
    ).toThrow(".zpi/commands");
    expect(
      () => new CommandImportService({ homeDirectory: "relative", targetDirectory: "/tmp/commands" }),
    ).toThrow("绝对");
  });

  it("rejects symlink ancestors above injected home and project roots", async () => {
    const { root, home } = await fixture();
    const alias = join(root, "alias");
    await symlink(home, alias, "dir");
    const service = new CommandImportService({
      homeDirectory: alias,
      targetDirectory: join(alias, ".zpi", "commands"),
    });
    await expect(service.discover()).rejects.toThrow("符号链接目录");
  });

  it("reports source symlink roots and oversized files without reading through them", async () => {
    const { root, home, service, put } = await fixture();
    await put(".codex/commands/large.md", "x".repeat(256 * 1024 + 1));
    await mkdir(join(root, "external"));
    await symlink(join(root, "external"), join(home, ".claude"), "dir");
    const discovery = await service.discover();
    expect(discovery.sources).toEqual([]);
    expect(discovery.warnings.join("\n")).toContain("256 KiB");
    expect(discovery.warnings.join("\n")).toContain("符号链接目录");
  });
});

describe("command imports", () => {
  it("copies selected files byte-for-byte, without executing command content", async () => {
    const { target, service, put } = await fixture();
    const content = "---\ndescription: Test\ncustom-key: untouched\n---\n!`rm -rf never-run` $ARGUMENTS\r\n";
    await put(".claude/commands/tools/review.md", content);
    await put(".claude/commands/unselected.md", "No");
    const discovery = await service.discover();
    const input = request(discovery);
    input.selections = input.selections.filter(
      ({ id }) => discovery.sources[0].commands.find((item) => item.id === id)?.name === "/tools/review",
    );
    const result = await service.importSelected(input);
    expect(result).toMatchObject({ importedCount: 1, skippedCount: 0, failedCount: 0 });
    expect(await readFile(join(target, "tools/review.md"), "utf8")).toBe(content);
    await expect(lstat(join(target, "unselected.md"))).rejects.toHaveProperty("code", "ENOENT");
  });

  it("skips exact and case-insensitive conflicts, including another selected source", async () => {
    const { target, service, put } = await fixture();
    await put(".claude/commands/review.md", "Claude");
    await put(".codex/commands/REVIEW.md", "Codex");
    await put(".qwen/commands/exists.md", "Source");
    await mkdir(target, { recursive: true });
    await writeFile(join(target, "exists.md"), "Keep");
    const discovery = await service.discover();
    expect(discovery.sources.at(-1)?.commands[0]).toMatchObject({
      importable: false,
      skipReason: "targetExists",
    });
    const result = await service.importSelected(request(discovery));
    expect(result).toMatchObject({ importedCount: 1, skippedCount: 2, failedCount: 0 });
    expect(result.items.map((item) => item.skipReason)).toEqual([
      undefined,
      "sameNameExists",
      "targetExists",
    ]);
    expect(await readFile(join(target, "exists.md"), "utf8")).toBe("Keep");
  });

  it("revalidates revision after discovery and leaves changed sources unimported", async () => {
    const { target, service, put } = await fixture();
    const source = await put(".claude/commands/review.md", "Before");
    const discovery = await service.discover();
    await writeFile(source, "After");
    const result = await service.importSelected(request(discovery));
    expect(result.failedCount).toBe(1);
    expect(result.items[0].error).toContain("重新扫描");
    await expect(lstat(target)).rejects.toHaveProperty("code", "ENOENT");
  });

  it("rejects unknown IDs, forged revisions, expired scans and duplicate selections", async () => {
    const { service, put } = await fixture();
    await put(".claude/commands/review.md");
    const discovery = await service.discover();
    const input = request(discovery);
    await expect(service.importSelected({ ...input, scanId: "unseen" })).rejects.toThrow("过期");
    await expect(
      service.importSelected({ ...input, selections: [{ id: "../../secret.md", revision: "fake" }] }),
    ).rejects.toThrow("过期");
    await expect(
      service.importSelected({ ...input, selections: [{ ...input.selections[0], revision: "fake" }] }),
    ).rejects.toThrow("过期");
    await expect(
      service.importSelected({ ...input, selections: [...input.selections, ...input.selections] }),
    ).rejects.toThrow("选择无效");
  });

  it("refuses a source replaced by a symlink after discovery", async () => {
    const { root, target, service, put } = await fixture();
    const source = await put(".claude/commands/review.md");
    const discovery = await service.discover();
    const outside = join(root, "private.md");
    await writeFile(outside, "Private");
    await unlink(source);
    await symlink(outside, source, "file");
    expect((await service.importSelected(request(discovery))).failedCount).toBe(1);
    await expect(lstat(target)).rejects.toHaveProperty("code", "ENOENT");
  });

  it("refuses a target directory symlink introduced after discovery", async () => {
    const { root, target, service, put } = await fixture();
    await put(".claude/commands/nested/review.md");
    const discovery = await service.discover();
    const outside = join(root, "outside");
    await mkdir(outside);
    await mkdir(target, { recursive: true });
    await symlink(outside, join(target, "nested"), "dir");
    expect((await service.importSelected(request(discovery))).failedCount).toBe(1);
    expect(await readdir(outside)).toEqual([]);
  });

  it("never overwrites even a dangling target symlink", async () => {
    const { root, target, service, put } = await fixture();
    await put(".claude/commands/review.md");
    await mkdir(target, { recursive: true });
    await symlink(join(root, "missing"), join(target, "review.md"));
    const discovery = await service.discover();
    expect((await service.importSelected(request(discovery))).skippedCount).toBe(1);
    expect(await readlink(join(target, "review.md"))).toBe(join(root, "missing"));
  });

  it("publishes a complete staged copy without clobbering a concurrent file", async () => {
    const { target, service, put } = await fixture();
    await put(".claude/commands/review.md", "Complete content");
    const input = request(await service.discover());
    const real = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    vi.mocked(link).mockImplementationOnce(async (temporary, destination) => {
      expect(await readFile(temporary, "utf8")).toBe("Complete content");
      await writeFile(destination, "Concurrent content", { flag: "wx" });
      return real.link(temporary, destination);
    });
    expect((await service.importSelected(input)).skippedCount).toBe(1);
    expect(await readFile(join(target, "review.md"), "utf8")).toBe("Concurrent content");
    expect(await readdir(target)).toEqual(["review.md"]);
  });

  it("finishes copy publication with one link and no staging files", async () => {
    const { target, service, put } = await fixture();
    await put(".claude/commands/review.md");
    expect((await service.importSelected(request(await service.discover()))).importedCount).toBe(1);
    expect((await lstat(join(target, "review.md"))).nlink).toBe(1);
    expect(await readdir(target)).toEqual(["review.md"]);
  });

  it("serializes simultaneous imports and reports the second as skipped", async () => {
    const { service, put } = await fixture();
    await put(".claude/commands/review.md");
    const input = request(await service.discover());
    const results = await Promise.all([service.importSelected(input), service.importSelected(input)]);
    expect(results.map((result) => [result.importedCount, result.skippedCount])).toEqual([
      [1, 0],
      [0, 1],
    ]);
  });
});

describe("explicit linked imports", () => {
  it("records approved links, survives a fresh importer instance, and the store follows only those files", async () => {
    const { home, target, service, put } = await fixture();
    const source = await put(".claude/commands/review.md", "Before");
    const result = await service.importSelected(request(await service.discover(), "symlink"));
    expect(result.items[0]).toMatchObject({ status: "imported", method: "symlink" });
    expect(await readlink(join(target, "review.md"))).toBe(source);
    const reopened = new CommandImportService({ homeDirectory: home, targetDirectory: target });
    expect(await reopened.registeredLinkTargets()).toEqual(new Map([["review.md", source]]));
    const store = new CustomCommandsStore({
      rootDirectory: target,
      stateFilePath: join(home, ".zpi", "command-state.json"),
      importedLinkTargets: () => reopened.registeredLinkTargets(),
    });
    expect((await store.list()).commands[0]).toMatchObject({
      name: "/review",
      prompt: "Before",
      importedSourcePath: source,
    });
    await writeFile(source, "After");
    expect((await store.list()).commands[0].prompt).toBe("After");
    const other = await put(".claude/commands/other.md", "Other");
    await unlink(join(target, "review.md"));
    await symlink(other, join(target, "review.md"));
    expect((await store.list()).commands).toEqual([]);
  });

  it("filters fabricated provenance outside known source roots and blocks a symlink registry", async () => {
    const { root, target, service } = await fixture();
    await mkdir(target, { recursive: true });
    const registry = join(target, ".import-links.json");
    await writeFile(
      registry,
      JSON.stringify({ "bad.md": join(root, "private.md"), "../bad.md": join(root, "private.md") }),
    );
    expect((await service.registeredLinkTargets()).size).toBe(0);
    await unlink(registry);
    const outside = join(root, "external.json");
    await writeFile(outside, "{}");
    await symlink(outside, registry);
    await expect(service.registeredLinkTargets()).rejects.toThrow("普通 Markdown");
  });

  it("reports Windows symlink permission failure without substituting a hard link or copy", async () => {
    const { target, service, put } = await fixture(false, "win32");
    await put(".claude/commands/review.md");
    const input = request(await service.discover(), "symlink");
    vi.mocked(symlink).mockRejectedValueOnce(
      Object.assign(new Error("privilege required"), { code: "EPERM" }),
    );
    const result = await service.importSelected(input);
    expect(result).toMatchObject({ importedCount: 0, skippedCount: 0, failedCount: 1 });
    expect(result.items[0].error).toContain("直接复制");
    expect(await readdir(target)).toEqual([]);
    expect(vi.mocked(link)).not.toHaveBeenCalled();
  });

  it("uses an actual approved symlink on Windows instead of an untracked hard link", async () => {
    const { target, service, put } = await fixture(false, "win32");
    const source = await put(".claude/commands/review.md", "Before");
    const result = await service.importSelected(request(await service.discover(), "symlink"));
    expect(result.items[0]).toMatchObject({ status: "imported", method: "symlink" });
    expect((await lstat(join(target, "review.md"))).isSymbolicLink()).toBe(true);
    expect(await service.registeredLinkTargets()).toEqual(new Map([["review.md", source]]));
    await writeFile(source, "After");
    expect(await readFile(join(target, "review.md"), "utf8")).toBe("After");
  });
});
