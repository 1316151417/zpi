import { createHash } from "node:crypto";
import { mkdtemp, readFile, realpath, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emptyAssistant, type JsonObject } from "@zpi-dev/ai";
import { type FileChange, SessionManager } from "@zpi-dev/coding-agent";
import { afterEach, expect, test } from "vitest";
import { fakeModel } from "../../../tests/fake-server.ts";
import { stableUuid } from "../src/messages.ts";
import { getSessionInfo, getSessionMessages, listSessions, rewindFiles } from "../src/sessions.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "zpi-sdk-sessions-")));
  roots.push(root);
  const directory = join(root, "sessions");
  const target = SessionManager.create(root, directory, { id: "target" });
  target.appendMessage({ role: "user", content: "First request", timestamp: 1 });
  target.appendSessionInfo("Target title");
  await target.appendCustomEntryAsync("sdk.tag", "tagged");
  return { root, directory, target, zpi: { agentDir: root } };
}

test("ID lookup ignores list limits and unrelated corrupt histories, and never creates a missing session", async () => {
  const f = await fixture();
  await writeFile(join(f.directory, "corrupt.jsonl"), "corrupt session\n");
  expect(await getSessionInfo("target", { zpi: f.zpi, limit: 0 })).toMatchObject({
    sessionId: "target",
    summary: "Target title",
    firstPrompt: "First request",
    tag: "tagged",
    cwd: f.root,
  });
  expect(await getSessionInfo("target", { zpi: f.zpi, dir: join(f.root, "other") })).toBeUndefined();
  expect(await getSessionInfo("missing", { zpi: f.zpi })).toBeUndefined();
  await expect(readFile(join(f.directory, "missing.jsonl"))).rejects.toMatchObject({ code: "ENOENT" });
  await expect(getSessionInfo("corrupt", { zpi: f.zpi })).rejects.toThrow("Corrupt session");
});

test("listing limits matching directories by recency before opening unused histories", async () => {
  const f = await fixture();
  SessionManager.create(join(f.root, "other"), f.directory, { id: "foreign" });
  const corrupt = join(f.directory, "corrupt.jsonl");
  await writeFile(corrupt, "corrupt session\n");
  await utimes(join(f.directory, "foreign.jsonl"), 300, 300);
  await utimes(join(f.directory, "target.jsonl"), 200, 200);
  await utimes(corrupt, 100, 100);
  expect(await listSessions({ zpi: f.zpi, dir: f.root, limit: 1 })).toMatchObject([{ sessionId: "target" }]);
  expect(await listSessions({ zpi: f.zpi, limit: 1 })).toMatchObject([{ sessionId: "foreign" }]);
  expect(await listSessions({ zpi: f.zpi, limit: 0 })).toEqual([]);
});

test("message pages preserve public UUIDs and apply system-message inclusion before the offset", async () => {
  const f = await fixture();
  const assistant = emptyAssistant(fakeModel("https://example.test/v1"));
  assistant.content = [{ type: "text", text: "Answer" }];
  f.target.appendMessage(assistant);
  f.target.appendMessage({ role: "system", content: "System context", timestamp: 2 });
  f.target.appendCustomEntry("sdk.user", { uuid: "public-user-id", text: "Second request" });
  f.target.appendMessage({ role: "user", content: "Second request", timestamp: 3 });
  const page = await getSessionMessages("target", { zpi: f.zpi, offset: 1, limit: 2 });
  expect(page.map((message) => message.type)).toEqual(["assistant", "user"]);
  expect(page[1]).toMatchObject({ uuid: "public-user-id", message: { content: "Second request" } });
  expect(
    await getSessionMessages("target", { zpi: f.zpi, offset: 2, limit: 1, includeSystemMessages: true }),
  ).toMatchObject([{ type: "system", message: { content: "System context" } }]);
});

const hash = (text: string) => createHash("sha256").update(text).digest("hex");
function record(manager: SessionManager, change: FileChange) {
  manager.appendMessage({
    role: "toolResult",
    toolCallId: change.toolCallId,
    toolName: "Write",
    content: [{ type: "text", text: "Changed" }],
    details: { fileChange: change } as unknown as JsonObject,
    isError: false,
    timestamp: 1,
  });
}

test("file rewind rejects a broken intermediate write chain without overwriting external work", async () => {
  const f = await fixture();
  const manager = SessionManager.inMemory(f.root);
  const user = manager.appendMessage({ role: "user", content: "Change", timestamp: 1 });
  const path = join(f.root, "file.txt"),
    beforeFile = join(f.root, "before.txt");
  await writeFile(path, "final agent version");
  await writeFile(beforeFile, "original");
  record(manager, {
    path,
    toolCallId: "one",
    operation: "modified",
    beforeHash: hash("original"),
    afterHash: hash("first agent version"),
    beforeFile,
  });
  record(manager, {
    path,
    toolCallId: "two",
    operation: "modified",
    beforeHash: hash("external edit"),
    afterHash: hash("final agent version"),
  });
  expect(await rewindFiles(manager, stableUuid(user))).toMatchObject({
    canRewind: false,
    error: expect.any(String),
  });
  expect(await readFile(path, "utf8")).toBe("final agent version");
});

test("file rewind supports dry run and restores all tracked writes", async () => {
  const f = await fixture();
  const manager = SessionManager.inMemory(f.root);
  const user = manager.appendMessage({ role: "user", content: "Change", timestamp: 1 });
  const modified = join(f.root, "modified.txt"),
    created = join(f.root, "created.txt"),
    beforeFile = join(f.root, "before.txt");
  await writeFile(modified, "updated");
  await writeFile(created, "created");
  await writeFile(beforeFile, "original");
  record(manager, {
    path: modified,
    toolCallId: "one",
    operation: "modified",
    beforeHash: hash("original"),
    afterHash: hash("updated"),
    beforeFile,
  });
  record(manager, {
    path: created,
    toolCallId: "two",
    operation: "created",
    beforeHash: null,
    afterHash: hash("created"),
  });
  expect(await rewindFiles(manager, stableUuid(user), true)).toEqual({
    canRewind: true,
    filesChanged: [modified, created],
  });
  expect(await readFile(modified, "utf8")).toBe("updated");
  expect(await readFile(created, "utf8")).toBe("created");
  expect(await rewindFiles(manager, stableUuid(user))).toEqual({
    canRewind: true,
    filesChanged: [modified, created],
  });
  expect(await readFile(modified, "utf8")).toBe("original");
  await expect(readFile(created)).rejects.toMatchObject({ code: "ENOENT" });
});

test("file rewind succeeds for a known user without changes and diagnoses unknown users", async () => {
  const manager = SessionManager.inMemory();
  const user = manager.appendMessage({ role: "user", content: "No writes", timestamp: 1 });
  expect(await rewindFiles(manager, stableUuid(user))).toEqual({ canRewind: true, filesChanged: [] });
  expect(await rewindFiles(manager, "missing")).toEqual({
    canRewind: false,
    error: "User message not found",
  });
});
