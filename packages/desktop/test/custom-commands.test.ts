import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CustomCommandsStore,
  type CustomCommandsStoreOptions,
  parseCustomCommandMarkdown,
  validateCustomCommandName,
} from "../src/main/custom-commands.ts";

let temporary: string;
let root: string;
let state: string;
let store: CustomCommandsStore;
function makeStore(options: Partial<CustomCommandsStoreOptions> = {}) {
  return new CustomCommandsStore({ rootDirectory: root, stateFilePath: state, ...options });
}
async function put(id: string, content: string) {
  const path = join(root, id);
  await fs.mkdir(dirname(path), { recursive: true });
  await fs.writeFile(path, content);
  return path;
}
beforeEach(async () => {
  temporary = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "zpi-custom-commands-")));
  root = join(temporary, ".zpi", "commands");
  state = join(temporary, ".zpi", "command-state.json");
  store = makeStore();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(temporary, { recursive: true, force: true });
});

describe("custom command Markdown", () => {
  it("reads scalar, quoted, CRLF, folded and literal metadata without interpreting prompt text", () => {
    expect(
      parseCustomCommandMarkdown(
        "---\r\ndescription: 'Review: it''s useful'\r\nargument-hint: \"file\"\r\n---\r\n\r\nRun $1 and $ARGUMENTS",
      ),
    ).toEqual({
      description: "Review: it's useful",
      argumentHint: "file",
      prompt: "Run $1 and $ARGUMENTS",
    });
    expect(
      parseCustomCommandMarkdown(
        "---\ndescription: >\n  Review the\n  current changes\nargument-hint: |\n  file\n  context\n---\nPrompt",
      ),
    ).toEqual({
      description: "Review the current changes",
      argumentHint: "file\ncontext",
      prompt: "Prompt",
    });
  });
  it.each([
    ["frontend-review", ["frontend-review"]],
    ["frontend-review, testing", ["frontend-review", "testing"]],
    ["[frontend-review, testing]", ["frontend-review", "testing"]],
    [`["frontend-review", 'testing']`, ["frontend-review", "testing"]],
    ['"frontend-review, testing"', ["frontend-review", "testing"]],
    ["frontend-review, frontend-review", ["frontend-review"]],
    ["[]", []],
  ])("parses inert flat skills metadata %s", (value, skills) => {
    expect(parseCustomCommandMarkdown(`---\nskills: ${value}\n---\nPrompt`).skills).toEqual(skills);
  });
  it.each([
    ["true", true],
    ["yes", true],
    ['"YES"', true],
    ['" YES "', true],
    ["false", false],
    ["no", false],
    ["other", false],
  ])("parses disable-noninteractive %s", (value, expected) => {
    expect(
      parseCustomCommandMarkdown(`---\ndisable-noninteractive: ${value}\n---\nPrompt`).disableNonInteractive,
    ).toBe(expected);
  });
  it("bounds skill metadata and never evaluates YAML tags or aliases", () => {
    expect(() => parseCustomCommandMarkdown(`---\nskills: ${"x".repeat(129)}\n---\nPrompt`)).toThrow(
      "invalid_frontmatter",
    );
    expect(() =>
      parseCustomCommandMarkdown(
        `---\nskills: ${Array.from({ length: 65 }, (_, index) => `skill-${index}`).join(",")}\n---\nPrompt`,
      ),
    ).toThrow("invalid_frontmatter");
    expect(() => parseCustomCommandMarkdown("---\nskills: [broken\n---\nPrompt")).toThrow(
      "invalid_frontmatter",
    );
    expect(parseCustomCommandMarkdown("---\nskills: !!custom-tag, *alias\n---\nPrompt").skills).toEqual([
      "!!custom-tag",
      "*alias",
    ]);
    expect(parseCustomCommandMarkdown("Prompt").skills).toBeUndefined();
    expect(parseCustomCommandMarkdown("Prompt").disableNonInteractive).toBeUndefined();
  });
  it("only reads frontmatter at the start and reports an unclosed fence", () => {
    const prompt = "A prompt\n---\ndescription: ordinary prompt text\n---\nEnd";
    expect(parseCustomCommandMarkdown(prompt).prompt).toBe(prompt);
    expect(parseCustomCommandMarkdown(prompt).description).toBeUndefined();
    expect(() => parseCustomCommandMarkdown("---\ndescription: broken")).toThrow("invalid_frontmatter");
    expect(parseCustomCommandMarkdown("\uFEFF---\ndescription: yes\n---\nPrompt").description).toBe("yes");
  });
  it.each(["", "../escape", "two words", "a/b", "中文", "a".repeat(51), "a.md", "a\\b"])(
    "rejects unsafe new name %s",
    (name) => expect(() => validateCustomCommandName(name)).toThrow("invalid_input"),
  );
  it("accepts documented new-name characters and a leading display slash", () => {
    expect(validateCustomCommandName("/Review_123-ok")).toBe("Review_123-ok");
  });
});

describe("custom command storage", () => {
  it("lists an absent directory without creating any files", async () => {
    expect(await store.list()).toEqual({ commands: [], diagnostics: [], directoryPath: root });
    expect(await fs.readdir(temporary)).toEqual([]);
  });
  it("creates, persists enable state, updates, renames, deletes and resets a recreated command", async () => {
    const created = await store.create({
      name: "review",
      description: "Review changes",
      argumentHint: "[file]",
      prompt: "Review $1",
    });
    expect(created).toMatchObject({ id: "review.md", name: "/review", enabled: true, prompt: "Review $1" });
    expect(created.revision).toMatch(/^[a-f0-9]{64}$/);
    await store.setEnabled({ id: created.id, enabled: false });
    expect((await makeStore().list()).commands[0].enabled).toBe(false);
    const updated = await store.update({
      id: created.id,
      expectedRevision: created.revision,
      name: "inspect",
      prompt: "Inspect changes",
    });
    expect(updated).toMatchObject({
      id: "inspect.md",
      name: "/inspect",
      enabled: false,
      prompt: "Inspect changes",
    });
    expect(await fs.readdir(root)).toEqual(["inspect.md"]);
    await store.delete({ id: updated.id, expectedRevision: updated.revision });
    expect((await store.list()).commands).toEqual([]);
    expect((await store.create({ name: "inspect", prompt: "New" })).enabled).toBe(true);
  });
  it("preserves unknown frontmatter blocks, comments, and existing nested names on update", async () => {
    await put(
      "tools/Legacy Name.md",
      "---\n# Keep this comment\nallowed-tools:\n  - read\n  - bash\ncustom: |\n  keep: exactly\n  second line\ndescription: old\n  continuation\nargument-hint: old hint\n---\nOld prompt",
    );
    const original = (await store.list()).commands[0];
    const updated = await store.update({
      id: original.id,
      expectedRevision: original.revision,
      name: original.name,
      description: "New: description",
      argumentHint: "[new]\ncontext",
      prompt: "New prompt",
    });
    expect(updated.name).toBe("/tools/Legacy Name");
    expect(updated.argumentHint).toBe("[new]\ncontext");
    const raw = await fs.readFile(updated.filePath, "utf8");
    expect(raw).toContain(
      "# Keep this comment\nallowed-tools:\n  - read\n  - bash\ncustom: |\n  keep: exactly\n  second line",
    );
    expect(raw).not.toContain("continuation");
    expect(updated.description).toBe("New: description");
  });
  it("preserves unknown quoted and dotted frontmatter keys after a managed key", async () => {
    await put(
      "unknown.md",
      `---
description: Original
"quoted-key":
  keep: quoted
custom.key:
  keep: dotted
---
Original prompt`,
    );
    const original = (await store.list()).commands[0];
    expect(original.description).toBe("Original");
    const updated = await store.update({
      id: original.id,
      expectedRevision: original.revision,
      description: "Changed",
      prompt: "Changed prompt",
    });
    const content = await fs.readFile(updated.filePath, "utf8");
    expect(content).toContain('"quoted-key":\n  keep: quoted\ncustom.key:\n  keep: dotted');
    expect(updated.description).toBe("Changed");
  });
  it("preserves skills, interaction visibility, and unapplied model/tool metadata when editing", async () => {
    await put(
      "metadata.md",
      "---\nskills: [frontend-review, testing]\ndisable-noninteractive: yes\nmodel: other-model\nallowed-tools: bash\n---\nOriginal",
    );
    const command = (await store.list()).commands[0];
    expect(command).toMatchObject({ skills: ["frontend-review", "testing"], disableNonInteractive: true });
    const updated = await store.update({
      id: command.id,
      expectedRevision: command.revision,
      prompt: "Changed",
      description: "New",
    });
    expect(updated).toMatchObject({ skills: ["frontend-review", "testing"], disableNonInteractive: true });
    expect(await fs.readFile(updated.filePath, "utf8")).toContain(
      "skills: [frontend-review, testing]\ndisable-noninteractive: yes\nmodel: other-model\nallowed-tools: bash",
    );
  });
  it("does not mistake a new prompt's opening horizontal rule for metadata", async () => {
    const command = await store.create({ name: "rule", prompt: "---\nMarkdown content" });
    expect(command.prompt).toBe("---\nMarkdown content");
  });
  it("lists nested Markdown alphabetically, ignores hidden/non-Markdown files, and reports bad files", async () => {
    await put("z.md", "Z");
    await put("a/sub.md", "Nested");
    await put("b.MD", "B");
    await put(".hidden.md", "Hidden");
    await put(".hidden/secret.md", "Hidden");
    await put("notes.txt", "Ignore");
    await put("broken.md", "---\nInvalid");
    const result = await store.list();
    expect(result.commands.map((item) => item.name)).toEqual(["/a/sub", "/b", "/z"]);
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: "invalid_frontmatter" }));
  });
  it("never overwrites a create/rename collision or a stale external edit", async () => {
    const original = await store.create({ name: "one", prompt: "One" });
    await store.create({ name: "two", prompt: "Two" });
    await expect(store.create({ name: "one", prompt: "Overwrite" })).rejects.toThrow("conflict");
    await expect(
      store.update({
        id: original.id,
        expectedRevision: original.revision,
        name: "two",
        prompt: "Overwrite",
      }),
    ).rejects.toThrow("conflict");
    expect(await fs.readFile(original.filePath, "utf8")).toBe("One");
    await fs.writeFile(original.filePath, "External change");
    await expect(
      store.update({ id: original.id, expectedRevision: original.revision, prompt: "Stale" }),
    ).rejects.toThrow("conflict");
    await expect(store.delete({ id: original.id, expectedRevision: original.revision })).rejects.toThrow(
      "conflict",
    );
    expect(await fs.readFile(original.filePath, "utf8")).toBe("External change");
  });
  it("rejects case-insensitive create and rename collisions", async () => {
    const original = await store.create({ name: "Review", prompt: "Original" });
    const other = await store.create({ name: "other", prompt: "Other" });
    await expect(store.create({ name: "review", prompt: "Overwrite" })).rejects.toThrow("case-insensitive");
    await expect(
      store.update({ id: other.id, expectedRevision: other.revision, name: "REVIEW", prompt: "Overwrite" }),
    ).rejects.toThrow("case-insensitive");
    await expect(
      store.update({
        id: original.id,
        expectedRevision: original.revision,
        name: "review",
        prompt: "Change case",
      }),
    ).rejects.toThrow("case-insensitive");
    expect(await fs.readFile(original.filePath, "utf8")).toBe("Original");
    expect(await fs.readFile(other.filePath, "utf8")).toBe("Other");
  });
  it.skipIf(process.platform === "darwin" || process.platform === "win32")(
    "selects one casefold duplicate deterministically and diagnoses it without changing files",
    async () => {
      await put("review.md", "Lowercase");
      await put("Review.md", "Uppercase");
      await put("tools/a.md", "Nested lowercase");
      await put("Tools/A.md", "Nested uppercase");
      const result = await store.list();
      expect(result.commands.map((command) => command.name)).toEqual(["/Review", "/Tools/A"]);
      expect(result.diagnostics.filter((item) => item.code === "duplicate_name")).toHaveLength(2);
      expect(await fs.readFile(join(root, "review.md"), "utf8")).toBe("Lowercase");
      expect(await fs.readFile(join(root, "tools/a.md"), "utf8")).toBe("Nested lowercase");
    },
  );
  it("retains editable legacy names with an invocation diagnostic", async () => {
    await put("tools/Legacy Name.md", "Legacy");
    const result = await store.list();
    expect(result.commands[0].name).toBe("/tools/Legacy Name");
    expect(result.diagnostics[0].code).toBe("unsupported_name");
  });
  it("serializes simultaneous updates and survives a rejected mutation", async () => {
    const original = await store.create({ name: "one", prompt: "One" });
    const results = await Promise.allSettled([
      store.update({ id: original.id, expectedRevision: original.revision, prompt: "First" }),
      store.update({ id: original.id, expectedRevision: original.revision, prompt: "Second" }),
    ]);
    expect(results.map((result) => result.status)).toEqual(["fulfilled", "rejected"]);
    expect((await store.list()).commands[0].prompt).toBe("First");
    await store.setEnabled({ id: original.id, enabled: false });
    expect((await store.list()).commands[0].enabled).toBe(false);
  });
  it("keeps old content and cleans staging files after failed atomic publish", async () => {
    const original = await store.create({ name: "one", prompt: "One" });
    vi.spyOn(fs, "rename").mockRejectedValueOnce(new Error("disk failure"));
    await expect(
      store.update({ id: original.id, expectedRevision: original.revision, prompt: "New" }),
    ).rejects.toThrow("disk failure");
    expect(await fs.readFile(original.filePath, "utf8")).toBe("One");
    expect(await fs.readdir(root)).toEqual(["one.md"]);
  });
  it("keeps the old file if writing a staged replacement fails", async () => {
    const original = await store.create({ name: "one", prompt: "One" });
    const open = fs.open.bind(fs);
    vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const handle = await open(...args);
      if (String(args[0]).endsWith(".tmp"))
        vi.spyOn(handle, "writeFile").mockRejectedValueOnce(new Error("disk full"));
      return handle;
    });
    await expect(
      store.update({ id: original.id, expectedRevision: original.revision, prompt: "New" }),
    ).rejects.toThrow("disk full");
    expect(await fs.readFile(original.filePath, "utf8")).toBe("One");
    expect(await fs.readdir(root)).toEqual(["one.md"]);
  });
  it("rejects a modified staging file before replacing the original", async () => {
    const original = await store.create({ name: "one", prompt: "One" });
    const open = fs.open.bind(fs);
    vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const handle = await open(...args);
      if (String(args[0]).endsWith(".tmp")) {
        vi.spyOn(handle, "sync").mockImplementationOnce(async () => {
          await fs.writeFile(args[0], "Bad");
        });
      }
      return handle;
    });
    await expect(
      store.update({ id: original.id, expectedRevision: original.revision, prompt: "New" }),
    ).rejects.toThrow("conflict");
    expect(await fs.readFile(original.filePath, "utf8")).toBe("One");
    expect(await fs.readdir(root)).toEqual(["one.md"]);
  });
  it("handles a target created between the preflight and exclusive publication", async () => {
    const link = fs.link.bind(fs);
    vi.spyOn(fs, "link").mockImplementationOnce(async (source, target) => {
      await fs.writeFile(target, "External winner");
      return link(source, target);
    });
    await expect(store.create({ name: "one", prompt: "Mine" })).rejects.toThrow("conflict");
    expect(await fs.readFile(join(root, "one.md"), "utf8")).toBe("External winner");
    expect(await fs.readdir(root)).toEqual(["one.md"]);
  });
  it("preserves enable state when its atomic replacement fails", async () => {
    const command = await store.create({ name: "one", prompt: "One" });
    await store.setEnabled({ id: command.id, enabled: false });
    const original = await fs.readFile(state, "utf8");
    vi.spyOn(fs, "rename").mockRejectedValueOnce(new Error("state write failed"));
    await expect(store.setEnabled({ id: command.id, enabled: true })).rejects.toThrow("state write failed");
    expect(await fs.readFile(state, "utf8")).toBe(original);
    expect((await store.list()).commands[0].enabled).toBe(false);
  });
  it("rolls back a renamed file if removing the old path fails", async () => {
    const original = await store.create({ name: "one", prompt: "One" });
    const unlink = fs.unlink.bind(fs);
    vi.spyOn(fs, "unlink").mockImplementation(async (path) => {
      if (path === original.filePath) throw new Error("cannot remove original");
      return unlink(path);
    });
    await expect(
      store.update({ id: original.id, expectedRevision: original.revision, name: "two", prompt: "New" }),
    ).rejects.toThrow("cannot remove original");
    expect(await fs.readFile(original.filePath, "utf8")).toBe("One");
    expect(await fs.readdir(root)).toEqual(["one.md"]);
  });
  it("retains a corrupt state file and disables entries until repaired", async () => {
    await put("one.md", "One");
    await fs.writeFile(state, "broken JSON");
    const result = await store.list();
    expect(result.commands[0].enabled).toBe(false);
    expect(result.diagnostics[0].code).toBe("invalid_state");
    await expect(store.setEnabled({ id: "one.md", enabled: true })).rejects.toThrow("invalid_state");
    expect(await fs.readFile(state, "utf8")).toBe("broken JSON");
  });
  it("bounds file sizes, directory depth, scan entries and total bytes", async () => {
    await put("a.md", "12345");
    await put("b.md", "67890");
    await put("nested/deeper/c.md", "C");
    expect(
      (await makeStore({ limits: { maxFileBytes: 4 } }).list()).diagnostics.some(
        (item) => item.code === "file_limit",
      ),
    ).toBe(true);
    const depth = await makeStore({ limits: { maxDepth: 1 } }).list();
    expect(depth.commands.map((item) => item.id)).toEqual(["a.md", "b.md"]);
    expect(depth.diagnostics.some((item) => item.code === "scan_limit")).toBe(true);
    const count = await makeStore({ limits: { maxEntries: 1 } }).list();
    expect(count.commands).toEqual([]);
    expect(count.diagnostics[0].code).toBe("scan_limit");
    const bytes = await makeStore({ limits: { maxTotalBytes: 5 } }).list();
    expect(bytes.commands.map((item) => item.id)).toEqual(["a.md"]);
    expect(bytes.diagnostics.some((item) => item.code === "scan_limit")).toBe(true);
    await expect(
      makeStore({ limits: { maxFileBytes: 4 } }).create({ name: "big", prompt: "12345" }),
    ).rejects.toThrow("file_limit");
  });
  it("bounds bytes even when every file has invalid frontmatter", async () => {
    await put("a.md", "---\nbad");
    await put("b.md", "---\nbad");
    const result = await makeStore({ limits: { maxTotalBytes: 7 } }).list();
    expect(result.commands).toEqual([]);
    expect(result.diagnostics.map((item) => item.code)).toEqual(["invalid_frontmatter", "scan_limit"]);
  });
  it("rejects unsafe IDs before reading or changing outside files", async () => {
    const outside = join(temporary, "outside.md");
    await fs.writeFile(outside, "Untouched");
    for (const id of [
      "../outside.md",
      "a/../../outside.md",
      outside,
      "a\\b.md",
      "a//b.md",
      ".hidden.md",
      "a/./b.md",
      "a\u0000.md",
      "a:stream.md",
    ]) {
      await expect(store.update({ id, expectedRevision: "a".repeat(64), prompt: "Unsafe" })).rejects.toThrow(
        "invalid_input",
      );
      await expect(store.delete({ id, expectedRevision: "a".repeat(64) })).rejects.toThrow("invalid_input");
      await expect(store.setEnabled({ id, enabled: false })).rejects.toThrow("invalid_input");
    }
    expect(await fs.readFile(outside, "utf8")).toBe("Untouched");
  });
  it("rejects command and directory symlinks without reading or writing their targets", async () => {
    const outside = join(temporary, "outside");
    await fs.mkdir(outside);
    await fs.writeFile(join(outside, "source.md"), "Untouched");
    await fs.mkdir(root, { recursive: true });
    await fs.symlink(join(outside, "source.md"), join(root, "link.md"));
    await fs.symlink(outside, join(root, "linked-folder"), "dir");
    const result = await store.list();
    expect(result.commands).toEqual([]);
    expect(result.diagnostics.every((item) => item.code === "unsafe_path")).toBe(true);
    await expect(
      store.update({ id: "link.md", expectedRevision: "a".repeat(64), prompt: "Unsafe" }),
    ).rejects.toThrow("unsafe_path");
    await expect(store.create({ name: "link", prompt: "Unsafe" })).rejects.toThrow("conflict");
    await expect(
      store.update({ id: "linked-folder/source.md", expectedRevision: "a".repeat(64), prompt: "Unsafe" }),
    ).rejects.toThrow("unsafe_path");
    expect(await fs.readFile(join(outside, "source.md"), "utf8")).toBe("Untouched");
  });
  it.each(["root", "ancestor", "state"])("rejects a symlink at the %s", async (kind) => {
    const outside = join(temporary, "outside");
    await fs.mkdir(outside);
    if (kind === "root") {
      await fs.mkdir(dirname(root), { recursive: true });
      await fs.symlink(outside, root, "dir");
    } else if (kind === "ancestor") {
      await fs.symlink(outside, dirname(root), "dir");
    } else {
      await fs.mkdir(dirname(root), { recursive: true });
      await fs.writeFile(join(outside, "state.json"), '{"version":1,"disabled":[]}');
      await fs.symlink(join(outside, "state.json"), state);
    }
    await expect(store.create({ name: "unsafe", prompt: "Unsafe" })).rejects.toThrow("unsafe_path");
    const result = await store.list();
    expect(result.commands).toEqual([]);
    expect(result.diagnostics.some((item) => item.code === "unsafe_path")).toBe(true);
    expect(await fs.readdir(outside)).toEqual(kind === "state" ? ["state.json"] : []);
  });
  it("rejects a hardlinked command so editing cannot mutate a shared inode", async () => {
    const outside = join(temporary, "outside.md");
    await fs.writeFile(outside, "Untouched");
    await fs.mkdir(root, { recursive: true });
    await fs.link(outside, join(root, "hard.md"));
    expect((await store.list()).diagnostics[0].code).toBe("unsafe_path");
  });
  it("reads only explicitly registered links, confirms source edits and deletes only the local link", async () => {
    const source = join(temporary, "approved", "source.md");
    await fs.mkdir(dirname(source));
    await fs.writeFile(source, "Original source");
    await fs.mkdir(root, { recursive: true });
    const link = join(root, "linked.md");
    await fs.symlink(source, link);
    const registered = makeStore({ importedLinkTargets: async () => new Map([["linked.md", source]]) });
    const command = (await registered.list()).commands[0];
    expect(command).toMatchObject({ importedSourcePath: source, prompt: "Original source" });
    await expect(
      registered.update({ id: command.id, expectedRevision: command.revision, prompt: "New" }),
    ).rejects.toThrow("confirmation_required");
    await expect(
      registered.update({
        id: command.id,
        expectedRevision: command.revision,
        prompt: "New",
        confirmLinkedSource: true,
        expectedSourcePath: join(temporary, "other.md"),
      }),
    ).rejects.toThrow("confirmation_required");
    const updated = await registered.update({
      id: command.id,
      expectedRevision: command.revision,
      prompt: "New source",
      confirmLinkedSource: true,
      expectedSourcePath: source,
    });
    expect(await fs.readFile(source, "utf8")).toBe("New source");
    expect((await fs.lstat(link)).isSymbolicLink()).toBe(true);
    expect(updated.importedSourcePath).toBe(source);
    await registered.delete({ id: updated.id, expectedRevision: updated.revision });
    expect(await fs.readFile(source, "utf8")).toBe("New source");
    expect(await fs.readdir(root)).toEqual([]);
  });
  it("rejects a registered link whose target or source ancestry changed", async () => {
    await fs.mkdir(root, { recursive: true });
    const source = join(temporary, "approved.md");
    const other = join(temporary, "other.md");
    await fs.writeFile(source, "Approved");
    await fs.writeFile(other, "Other");
    await fs.symlink(other, join(root, "linked.md"));
    const registered = makeStore({ importedLinkTargets: async () => new Map([["linked.md", source]]) });
    expect((await registered.list()).diagnostics[0].code).toBe("unsafe_path");
    await fs.unlink(join(root, "linked.md"));
    await fs.symlink(source, join(root, "linked.md"));
    await fs.unlink(source);
    await fs.symlink(other, source);
    expect((await registered.list()).diagnostics[0].code).toBe("unsafe_path");
  });
  it.each(["missing", "malformed", "unsafe"])(
    "keeps a registered link with a %s source visible and safely deletable",
    async (kind) => {
      const source = join(temporary, "source.md");
      const outside = join(temporary, "outside.md");
      await fs.writeFile(source, "Original");
      await fs.writeFile(outside, "Never modify");
      await fs.mkdir(root, { recursive: true });
      const local = join(root, "linked.md");
      await fs.symlink(source, local);
      const registered = makeStore({ importedLinkTargets: async () => new Map([["linked.md", source]]) });
      if (kind === "malformed") await fs.writeFile(source, "---\nUnclosed");
      else {
        await fs.unlink(source);
        if (kind === "unsafe") await fs.symlink(outside, source);
      }
      const result = await registered.list();
      const command = result.commands[0];
      expect(command).toMatchObject({
        id: "linked.md",
        prompt: "",
        importedSourcePath: source,
        unreadable: true,
        enabled: false,
      });
      expect(result.diagnostics).toHaveLength(1);
      await expect(
        registered.update({
          id: command.id,
          expectedRevision: command.revision,
          confirmLinkedSource: true,
          expectedSourcePath: source,
          prompt: "Should not save",
        }),
      ).rejects.toThrow();
      await registered.delete({ id: command.id, expectedRevision: command.revision });
      expect(await fs.readdir(root)).toEqual([]);
      expect(await fs.readFile(outside, "utf8")).toBe("Never modify");
      if (kind === "malformed") expect(await fs.readFile(source, "utf8")).toBe("---\nUnclosed");
      if (kind === "unsafe") expect((await fs.lstat(source)).isSymbolicLink()).toBe(true);
    },
  );
  it("restores the persisted enabled preference when a broken source is repaired", async () => {
    const source = join(temporary, "source.md");
    await fs.mkdir(root, { recursive: true });
    await fs.symlink(source, join(root, "linked.md"));
    const registered = makeStore({ importedLinkTargets: async () => new Map([["linked.md", source]]) });
    expect((await registered.list()).commands[0]).toMatchObject({ unreadable: true, enabled: false });
    await fs.writeFile(source, "Repaired");
    expect((await registered.list()).commands[0]).toMatchObject({ enabled: true, prompt: "Repaired" });
    await registered.setEnabled({ id: "linked.md", enabled: false });
    await fs.unlink(source);
    expect((await registered.list()).commands[0].unreadable).toBe(true);
    await fs.writeFile(source, "Repaired again");
    expect((await registered.list()).commands[0]).toMatchObject({ enabled: false, prompt: "Repaired again" });
  });
  it("preserves a linked source and link when atomic source publication fails", async () => {
    const source = join(temporary, "source.md");
    await fs.writeFile(source, "Original");
    await fs.mkdir(root, { recursive: true });
    await fs.symlink(source, join(root, "linked.md"));
    const registered = makeStore({ importedLinkTargets: async () => new Map([["linked.md", source]]) });
    const command = (await registered.list()).commands[0];
    vi.spyOn(fs, "rename").mockRejectedValueOnce(new Error("source write failed"));
    await expect(
      registered.update({
        id: command.id,
        expectedRevision: command.revision,
        prompt: "New",
        confirmLinkedSource: true,
        expectedSourcePath: source,
      }),
    ).rejects.toThrow("source write failed");
    expect(await fs.readFile(source, "utf8")).toBe("Original");
    expect((await fs.lstat(command.filePath)).isSymbolicLink()).toBe(true);
  });
});
