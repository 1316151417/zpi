import { SessionManager } from "@zpi-dev/coding-agent";
import { afterEach, expect, test, vi } from "vitest";
import {
  InMemorySessionStore,
  projectKey,
  storeCall,
  TranscriptMirror,
  transcriptEntries,
  validateKey,
} from "../src/session-store.ts";
import type { SDKMirrorErrorMessage } from "../src/types.ts";

afterEach(() => vi.useRealTimers());
const key = { projectKey: "project", sessionId: "main" };
test("store preserves opaque entries, deduplicates retries, folds summaries and separates children", async () => {
  const store = new InMemorySessionStore();
  const manager = SessionManager.inMemory("/project", { id: "main" });
  manager.appendMessage({ role: "user", content: "Hello", timestamp: 1 });
  manager.appendSessionInfo("Title");
  const entries = transcriptEntries(manager);
  await Promise.all([store.append(key, entries), store.append(key, entries)]);
  expect(await store.load(key)).toEqual(entries);
  const copy = await store.load(key);
  if (!copy) throw new Error("Missing fixture entries");
  copy[1].type = "changed";
  expect(await store.load(key)).toEqual(entries);
  await store.append({ ...key, subpath: "subagents/agent-one" }, entries);
  expect(await store.listSubkeys(key)).toEqual(["subagents/agent-one"]);
  expect(await store.listSessionSummaries("project")).toMatchObject([
    { sessionId: "main", data: { cwd: "/project", firstPrompt: "Hello", customTitle: "Title" } },
  ]);
  await store.delete({ ...key, subpath: "subagents/agent-one" });
  expect(await store.listSubkeys(key)).toEqual([]);
});
test.each(["batched", "eager"] as const)(
  "%s mirror retries stable batches in order and drains",
  async (mode) => {
    const store = new InMemorySessionStore(),
      errors: SDKMirrorErrorMessage[] = [];
    const real = store.append.bind(store);
    const append = vi.spyOn(store, "append");
    let attempts = 0;
    append.mockImplementation(async (k, entries) => {
      await real(k, entries);
      if (attempts++ === 0) throw new Error("landed then failed");
    });
    const mirror = new TranscriptMirror(store, key, mode, (message) => errors.push(message));
    const manager = SessionManager.inMemory("/project", { id: "main" });
    mirror.attach(manager);
    await manager.appendCustomEntryAsync("one", { opaque: { nested: [1, 2] } });
    await manager.appendCustomEntryAsync("two", null);
    await mirror.close();
    expect(await store.load(key)).toEqual(transcriptEntries(manager));
    expect(errors).toEqual([]);
    expect(append.mock.calls[0][1]).toEqual(append.mock.calls[1][1]);
    expect(append.mock.calls.length).toBe(mode === "eager" ? 4 : 2);
  },
);
test("batched cadence flushes without waiting for turn end, eager emits individual frames", async () => {
  vi.useFakeTimers();
  const store = new InMemorySessionStore(),
    append = vi.spyOn(store, "append");
  const mirror = new TranscriptMirror(store, key, "batched", () => {}),
    manager = SessionManager.inMemory("/project", { id: "main" });
  mirror.attach(manager);
  manager.appendSessionInfo("first");
  await vi.advanceTimersByTimeAsync(99);
  expect(append).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(append).toHaveBeenCalledTimes(1);
  await mirror.close();
});
test("exhausted failures emit a mirror error and allow subsequent batches", async () => {
  const store = new InMemorySessionStore(),
    errors: SDKMirrorErrorMessage[] = [];
  const append = vi.spyOn(store, "append").mockRejectedValue(new Error("offline"));
  const mirror = new TranscriptMirror(store, key, "eager", (m) => errors.push(m)),
    manager = SessionManager.inMemory("/project", { id: "main" });
  mirror.attach(manager);
  await mirror.drain();
  expect(append).toHaveBeenCalledTimes(3);
  expect(errors).toMatchObject([{ subtype: "mirror_error", key, error: "offline" }]);
  append.mockRestore();
  manager.appendSessionInfo("recovered");
  await mirror.close();
  expect(await store.load(key)).toMatchObject([{ type: "session_info", name: "recovered" }]);
});
test("append timeout is not retried; load timeout and cancellation are bounded", async () => {
  vi.useFakeTimers();
  const store = new InMemorySessionStore(),
    append = vi.spyOn(store, "append").mockImplementation(() => new Promise(() => {})),
    errors: SDKMirrorErrorMessage[] = [];
  const mirror = new TranscriptMirror(store, key, "eager", (m) => errors.push(m));
  mirror.attach(SessionManager.inMemory("/project", { id: "main" }));
  const drained = mirror.close();
  await vi.advanceTimersByTimeAsync(60000);
  await drained;
  expect(append).toHaveBeenCalledTimes(1);
  expect(errors[0].error).toContain("timed out");
  const loaded = expect(storeCall("load", () => new Promise(() => {}), 10)).rejects.toThrow("timed out");
  await vi.advanceTimersByTimeAsync(10);
  await loaded;
  const controller = new AbortController();
  const canceled = expect(
    storeCall("load", () => new Promise(() => {}), 60000, controller.signal),
  ).rejects.toThrow("cancelled");
  controller.abort(new Error("cancelled"));
  await canceled;
});
test("keys reject traversal and long cwd scopes are deterministic", () => {
  for (const subpath of ["", "../escape", "subagents/agent-../x", "/tmp/file", "subagents/agent-x/next"])
    expect(() => validateKey({ ...key, subpath })).toThrow();
  expect(projectKey(`/tmp/${"x".repeat(400)}`)).toEqual(projectKey(`/tmp/${"x".repeat(400)}`));
  expect(projectKey(`/tmp/${"x".repeat(400)}a`)).not.toBe(projectKey(`/tmp/${"x".repeat(400)}b`));
});
