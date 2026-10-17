import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { link, mkdir, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentToolResult } from "zpi-agent";
import type { ExtensionToolContext, ToolDefinition } from "zpi-coding-agent";

const fs = await vi.hoisted(async () => {
  const actual = await import("node:fs/promises");
  return { ...actual, open: vi.fn(actual.open), lstat: vi.fn(actual.lstat), opendir: vi.fn(actual.opendir) };
});
vi.mock("node:fs/promises", () => fs);

import { createQuickChatFileTools, QUICK_CHAT_FILE_LIMITS } from "../src/main/quick-chat-tools.ts";

let base: string;
let root: string;
let tools: ToolDefinition[];
const text = (result: AgentToolResult) =>
  result.content.map((part) => (part.type === "text" ? part.text : "")).join("");
function run(name: string, args: unknown, signal?: AbortSignal) {
  const tool = tools.find((tool) => tool.name === name);
  if (!tool) throw new Error("Missing test tool");
  return tool.execute("test-call", args, signal, undefined, {} as ExtensionToolContext);
}
async function fixture(path: string, content: string | Buffer = "hello") {
  const full = join(root, path);
  await mkdir(join(full, ".."), { recursive: true });
  await writeFile(full, content);
  return full;
}

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "zpi-quick-chat-"));
  root = join(base, "workspace");
  await mkdir(root);
  tools = createQuickChatFileTools(root);
  vi.clearAllMocks();
});
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  fs.open.mockImplementation(actual.open);
  fs.lstat.mockImplementation(actual.lstat);
  fs.opendir.mockImplementation(actual.opendir);
  await rm(base, { recursive: true, force: true });
});

describe("quick-chat read-only file tools", () => {
  it("constructs exactly three read-only tools without touching the filesystem", () => {
    expect(tools.map((tool) => tool.name)).toEqual(["read", "list", "search"]);
    createQuickChatFileTools(join(base, "does-not-exist"));
    expect(fs.lstat).not.toHaveBeenCalled();
    expect(fs.open).not.toHaveBeenCalled();
    expect(fs.opendir).not.toHaveBeenCalled();
    for (const tool of tools) {
      expect(tool.metadata).toMatchObject({ readOnly: true, concurrentSafe: true, sideEffectScope: "none" });
      expect(tool.parameters).toMatchObject({ additionalProperties: false });
    }
  });

  it("reads ordinary UTF-8 source text and accepts bounded line ranges", async () => {
    const file = await fixture("src/example.ts", "one\n你好\nthree\nfour");
    const result = await run("read", { path: "src/example.ts", offset: 2, limit: 2 });
    expect(result.isError).toBe(false);
    expect(text(result)).toContain("2: 你好\n3: three");
    expect(text(result)).toContain("truncated");
    expect(text(await run("read", { path: file }))).toContain("4: four");
    const flags = fs.open.mock.calls[0][1] as number;
    expect(flags & constants.O_NONBLOCK).toBe(constants.O_NONBLOCK);
    if (constants.O_NOFOLLOW) expect(flags & constants.O_NOFOLLOW).toBe(constants.O_NOFOLLOW);
  });

  it("lists only on request, and searches literal strings with optional case sensitivity", async () => {
    await fixture("a.txt", "a.*b literal\nAlpha\naZZb");
    await fixture("nested/b.txt", "ALPHA");
    const listing = text(await run("list", { depth: 2 }));
    expect(listing).toContain("a.txt");
    expect(listing).toContain("nested/b.txt");
    const literal = text(await run("search", { query: "a.*b" }));
    expect(literal).toContain("a.txt:1: a.*b literal");
    expect(literal).not.toContain("aZZb");
    expect(text(await run("search", { query: "alpha" }))).toContain("nested/b.txt:1: ALPHA");
    expect(text(await run("search", { query: "Alpha", caseSensitive: true }))).not.toContain("ALPHA");
    expect(text(await run("search", { path: "a.txt", query: "Alpha" }))).toContain("a.txt:2: Alpha");
  });

  it.each(["../outside.txt", "../workspace-other/outside.txt"])(
    "rejects root traversal: %s",
    async (path) => {
      await writeFile(join(base, "outside.txt"), "outside-marker");
      const response = await run("read", { path });
      expect(response.isError).toBe(true);
      expect(text(response)).not.toContain(base);
      expect(text(response)).not.toContain("outside-marker");
      expect(fs.open).not.toHaveBeenCalled();
    },
  );

  it("rejects absolute outside paths without disclosing those paths", async () => {
    const outside = join(base, "outside.txt");
    await writeFile(outside, "outside-marker");
    const response = await run("read", { path: outside });
    expect(response.isError).toBe(true);
    expect(text(response)).not.toContain(base);
    expect(fs.open).not.toHaveBeenCalled();
  });

  it.each([
    ".env",
    ".env.local",
    ".ENV.production",
    ".ssh/id_rsa",
    ".aws/config",
    ".gnupg/private.key",
    ".git/config",
    ".codex/auth.json",
    ".claude/settings.json",
    ".zpi/settings.json",
    "auth.json",
    ".config/token",
    ".npmrc",
    ".netrc",
    "credentials.json",
    "secrets.yml",
    "private-key.txt",
    "service-account.json",
    "cert.pem",
    "wallet.p12",
    "id_ed25519.pub",
  ])("blocks sensitive files from read, list and search: %s", async (path) => {
    await fixture(path, "private-marker");
    expect((await run("read", { path })).isError).toBe(true);
    expect(fs.open).not.toHaveBeenCalled();
    expect(text(await run("list", { depth: 6 }))).not.toContain(path);
    expect(text(await run("search", { query: "private-marker" }))).not.toContain("private-marker");
    expect(fs.open).not.toHaveBeenCalled();
  });

  it("blocks directory and file symlinks even when their targets are inside the root", async () => {
    await fixture("normal/a.txt", "normal-marker");
    await mkdir(join(base, "outside"));
    await writeFile(join(base, "outside", "private.txt"), "outside-marker");
    await symlink(join(base, "outside"), join(root, "escape"), "dir");
    await symlink(join(root, "normal"), join(root, "alias"), "dir");
    await symlink(join(root, "normal/a.txt"), join(root, "alias.txt"));
    for (const path of ["escape/private.txt", "alias/a.txt", "alias.txt"])
      expect((await run("read", { path })).isError).toBe(true);
    const listing = text(await run("list", { depth: 6 }));
    expect(listing).not.toMatch(/escape|alias/);
    expect(text(await run("search", { query: "outside-marker" }))).not.toContain("outside-marker");
  });

  it("does not read hard-linked files that could alias a sensitive source", async () => {
    await fixture(".env", "private-marker");
    await link(join(root, ".env"), join(root, "notes.txt"));
    expect((await run("read", { path: "notes.txt" })).isError).toBe(true);
    expect(text(await run("search", { query: "private-marker" }))).not.toContain("private-marker");
    expect(fs.open).not.toHaveBeenCalled();
  });

  it.each([Buffer.from([1, 2, 0, 4]), Buffer.from([0xff, 0xfe, 0xfd])])(
    "rejects binary and invalid UTF-8",
    async (bytes) => {
      await fixture("data.bin", bytes);
      expect((await run("read", { path: "data.bin" })).isError).toBe(true);
      expect(text(await run("search", { query: "data" }))).toContain("No matching");
    },
  );

  it("rejects directories and oversized files before opening them", async () => {
    await fixture("large.txt", "x".repeat(QUICK_CHAT_FILE_LIMITS.fileBytes + 1));
    expect((await run("read", { path: "." })).isError).toBe(true);
    expect((await run("read", { path: "large.txt" })).isError).toBe(true);
    expect(fs.open).not.toHaveBeenCalled();
  });

  it.skipIf(process.platform === "win32")(
    "rejects FIFOs without opening or waiting for a writer",
    async () => {
      await promisify(execFile)("mkfifo", [join(root, "pipe")]);
      const result = await run("read", { path: "pipe" });
      expect(result.isError).toBe(true);
      expect(text(result)).toContain("regular text files");
      expect(fs.open).not.toHaveBeenCalled();
    },
  );

  it("checks the opened inode before reading a raced replacement", async () => {
    await fixture("note.txt", "safe");
    await fixture("replacement.txt", "replacement-marker");
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    fs.open.mockImplementationOnce(async (...args: Parameters<typeof actual.open>) => {
      await rename(join(root, "replacement.txt"), join(root, "note.txt"));
      const handle = await actual.open(...args);
      const read = vi.spyOn(handle, "read");
      const close = vi.spyOn(handle, "close");
      queueMicrotask(() => {
        expect(read).not.toHaveBeenCalled();
      });
      Object.assign(observed, { read, close });
      return handle;
    });
    const observed: { read?: ReturnType<typeof vi.spyOn>; close?: ReturnType<typeof vi.spyOn> } = {};
    const result = await run("read", { path: "note.txt" });
    expect(result.isError).toBe(true);
    expect(text(result)).not.toContain("replacement-marker");
    expect(observed.read).not.toHaveBeenCalled();
    expect(observed.close).toHaveBeenCalledOnce();
  });

  it("supports Windows-style relative paths under the Windows path policy", async () => {
    await fixture("nested/note.txt", "portable-marker");
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    expect(text(await run("read", { path: "nested\\note.txt" }))).toContain("portable-marker");
    expect(text(await run("search", { path: "nested", query: "portable-marker" }))).toContain(
      "nested/note.txt",
    );
    expect((await run("read", { path: "..\\outside.txt" })).isError).toBe(true);
  });

  it("rejects a root leaf symlink rather than expanding the available scope", async () => {
    await fixture("note.txt", "outside-marker");
    const alias = join(base, "alias");
    await symlink(root, alias, "dir");
    tools = createQuickChatFileTools(alias);
    expect((await run("read", { path: "note.txt" })).isError).toBe(true);
    expect(fs.open).not.toHaveBeenCalled();
  });

  it("retries initial root discovery after a missing folder is created", async () => {
    root = join(base, "created-later");
    tools = createQuickChatFileTools(root);
    expect((await run("list", {})).isError).toBe(true);
    await fixture("note.txt", "created-marker");
    expect(text(await run("read", { path: "note.txt" }))).toContain("created-marker");
  });

  it("detects replacement of the pinned root between calls", async () => {
    await fixture("note.txt", "original");
    expect(text(await run("read", { path: "note.txt" }))).toContain("original");
    await rename(root, join(base, "old-workspace"));
    await mkdir(root);
    await fixture("note.txt", "replacement-marker");
    expect((await run("read", { path: "note.txt" })).isError).toBe(true);
  });

  it("bounds output, search matches and directory breadth", async () => {
    await fixture("long.txt", "x".repeat(QUICK_CHAT_FILE_LIMITS.fileBytes));
    const read = text(await run("read", { path: "long.txt" }));
    expect(read.length).toBeLessThanOrEqual(QUICK_CHAT_FILE_LIMITS.outputChars);
    expect(read).toContain("truncated");
    await fixture("matches.txt", "find me\n".repeat(150));
    const search = text(await run("search", { path: "matches.txt", query: "find me" }));
    expect(search.match(/matches.txt:/g)).toHaveLength(QUICK_CHAT_FILE_LIMITS.matches);
    expect(search).toContain("truncated");
    for (let index = 0; index < 270; index++) await fixture(`wide/file-${index}.txt`);
    const list = text(await run("list", { path: "wide" }));
    expect(list.match(/wide\/file-/g)).toHaveLength(QUICK_CHAT_FILE_LIMITS.directoryEntries);
    expect(list).toContain("truncated");
  });

  it("bounds recursive depth and total content bytes", async () => {
    await fixture("a/b/c/d/e/f/g/deep.txt", "deep-marker");
    expect(text(await run("search", { query: "deep-marker" }))).not.toContain("deep-marker");
    for (let index = 0; index < 12; index++)
      await fixture(`large-${index}.txt`, "x".repeat(QUICK_CHAT_FILE_LIMITS.fileBytes));
    const result = await run("search", { query: "absent" });
    expect(text(result)).toContain("truncated");
    expect(fs.open.mock.calls.length).toBeLessThanOrEqual(9);
  });

  it.each([
    ["read", { path: "a", offset: 0 }],
    ["read", { path: "a", limit: 100_000 }],
    ["list", { depth: 7 }],
    ["search", { query: "" }],
    ["search", { query: "a".repeat(257) }],
    ["search", { query: "test", regex: true }],
    ["read", { path: "a\0b" }],
  ])("rejects invalid %s arguments", async (name, args) => {
    expect((await run(name as string, args)).isError).toBe(true);
    expect(fs.open).not.toHaveBeenCalled();
  });

  it("honors cancellation without reading", async () => {
    await fixture("note.txt");
    const controller = new AbortController();
    controller.abort();
    expect(text(await run("read", { path: "note.txt" }, controller.signal))).toContain("cancelled");
    expect(fs.open).not.toHaveBeenCalled();
  });

  it("returns within its deadline even when a filesystem operation stalls", async () => {
    vi.useFakeTimers();
    let release: (() => void) | undefined;
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    fs.lstat.mockImplementationOnce(async (...args: Parameters<typeof actual.lstat>) => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return actual.lstat(...args);
    });
    const pending = run("list", {});
    await vi.advanceTimersByTimeAsync(QUICK_CHAT_FILE_LIMITS.deadlineMs + 1);
    expect(text(await pending)).toContain("timed out");
    release?.();
    expect(fs.opendir).not.toHaveBeenCalled();
  });
});
