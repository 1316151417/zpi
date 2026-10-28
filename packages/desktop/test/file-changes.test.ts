import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createTwoFilesPatch } from "diff";
import { expect, test, vi } from "vitest";
import type { FileChange, SessionEntry } from "zpi-coding-agent";
import { chunk, done, send } from "../../../tests/fake-server.ts";
import * as changesModule from "../src/main/file-changes.ts";
import { copyFileChangeSnapshots, entryFileChange, fileChanges } from "../src/main/file-changes.ts";
import { projectEvent } from "../src/main/projection.ts";
import { SessionHost } from "../src/main/session-host.ts";
import { cleanup, fixture, run } from "./helpers/context-fixture.ts";

test("non-Git task changes merge original-to-final snapshots and survive archive/restart with drafts", async () => {
  const f = await fixture((_body, response, index) => {
    if (index < 2) {
      send(
        response,
        chunk({
          tool_calls: [
            {
              index: 0,
              id: `write-${index}`,
              type: "function",
              function: {
                name: "write",
                arguments: JSON.stringify({
                  path: "net.txt",
                  content: index === 0 ? "intermediate\n" : "final\n",
                }),
              },
            },
          ],
        }),
      );
      done(response, "tool_calls");
    } else {
      send(response, chunk({ content: "done" }));
      done(response);
    }
  });
  await writeFile(join(f.workspace, "net.txt"), "original\n");
  await run(f, "change twice");
  const entries = await f.host.getChanges(f.session.id, null);
  expect(entries).toHaveLength(1);
  expect(entries[0].patch).toContain("-original");
  expect(entries[0].patch).toContain("+final");
  expect(entries[0].patch).not.toContain("intermediate");
  const searchChanges = await f.host.getTaskSearchChanges(f.session.id);
  expect(searchChanges).toEqual([
    { path: entries[0].path, added: 1, removed: 1, lastTurnIndex: 0, writeCount: 2 },
  ]);
  const runId = f.host.getSessionSnapshot(f.session.id).view.runs[0].runId;
  expect((await f.host.getChanges(f.session.id, runId))[0].patch).toBe(entries[0].patch);
  const summary = await f.host.getChanges(f.session.id, runId, false, true);
  expect(summary[0]).toMatchObject({ added: 1, removed: 1 });
  expect(summary[0].patch).toBeUndefined();
  expect(await f.host.readPatch(f.session.id, null, entries[0].id)).toBe(entries[0].patch);
  const first = await f.host.readPatch(f.session.id, runId, "operation:write-0");
  const second = await f.host.readPatch(f.session.id, runId, "operation:write-1");
  expect(first).toContain("-original");
  expect(first).toContain("+intermediate");
  expect(first).not.toContain("+final");
  expect(second).toContain("-intermediate");
  expect(second).toContain("+final");
  expect(second).not.toContain("-original");
  expect(await f.host.getLastTurnReview(f.session.id)).toMatchObject({
    runId,
    entries: [{ path: entries[0].path, added: 1, removed: 1 }],
  });
  await run(f, "read only followup");
  expect((await f.host.getLastTurnReview(f.session.id)).entries).toEqual([]);
  await expect(f.host.readPatch(f.session.id, runId, "operation:missing")).rejects.toThrow("not_found");
  const otherSession = await f.host.createSession(null);
  await expect(f.host.readPatch(otherSession.id, null, "operation:write-0")).rejects.toThrow("not_found");
  f.host.saveDraft(f.session.id, { text: "未发送草稿", fileReferences: [], selection: [3, 3], revision: 1 });
  await f.host.archiveSession(f.session.id);
  expect(f.host.listRecentSessions().some((record) => record.id === f.session.id)).toBe(false);
  await f.host.close();
  const reopened = new SessionHost(f.dir, f.settings, f.resources, f.workspace, undefined);
  await reopened.init();
  cleanup.push(() => reopened.close());
  expect(reopened.listRecentSessions().some((record) => record.id === f.session.id)).toBe(false);
  expect((await reopened.getDraft(f.session.id)).text).toBe("未发送草稿");
  expect((await reopened.getChanges(f.session.id, null))[0].patch).toBe(entries[0].patch);
  expect(await reopened.getTaskSearchChanges(f.session.id)).toEqual(searchChanges);
  expect(await reopened.getChanges(f.session.id, runId, false, true)).toEqual(summary);
  expect(await reopened.readPatch(f.session.id, runId, "operation:write-1")).toBe(second);
});

test("tool projection includes small inline patches and defers larger UTF-8 payloads", () => {
  const project = (patch: string) =>
    projectEvent(
      {
        type: "tool_execution_end",
        toolCallId: "write",
        toolName: "write",
        isError: false,
        result: {
          content: [{ type: "text", text: "done" }],
          details: {
            fileChange: { path: "a.txt", patch, additions: 1, deletions: 1 },
          },
        },
      },
      "message",
    );
  const small = "--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-before\n+after\n";
  expect(project(small)).toMatchObject({ fileChange: { patch: small, additions: 1, deletions: 1 } });
  const big = `@@ -0,0 +1 @@\n+${"内容".repeat(12_000)}`;
  const projected = project(big);
  expect(projected).toMatchObject({ fileChange: { patchAvailable: true, additions: 1, deletions: 1 } });
  expect(projected && "fileChange" in projected && projected.fileChange?.patch).toBeUndefined();
});

test("file snapshots reject sibling directories and symlink escapes while retaining valid changes", async () => {
  const f = await fixture();
  const root = join(f.dir, "snapshots"),
    sibling = join(f.dir, "snapshots-other");
  await mkdir(root);
  await mkdir(sibling);
  const valid = join(root, "after"),
    outside = join(sibling, "after"),
    escaped = join(root, "escape");
  await writeFile(valid, "inside\n");
  await writeFile(outside, "outside\n");
  await symlink(outside, escaped);
  for (const [afterFile, allowed] of [
    [valid, true],
    [outside, false],
    [escaped, false],
    [root, false],
  ] as const) {
    const [item] = await fileChanges(
      [
        {
          path: "result.txt",
          toolCallId: "write",
          operation: "created",
          beforeHash: null,
          afterHash: "hash",
          afterFile,
        },
      ],
      root,
      "task",
    );
    if (allowed) {
      expect(item.patch).toContain("+inside");
      expect(item.snapshotUnavailable).toBeUndefined();
    } else {
      expect(item.patch).toBeUndefined();
      expect(item.reason).toContain("快照不属于此任务");
      expect(item.snapshotUnavailable).toBe(true);
    }
  }
});

test("forked binary snapshots preserve original bytes and do not rewrite parent history", async () => {
  const f = await fixture();
  const source = join(f.dir, "snapshots"),
    target = join(f.dir, "fork-snapshots");
  await mkdir(source);
  const before = Buffer.from([0, 255, 254, 195, 40]),
    after = Buffer.from([0, 255, 254, 195, 41]),
    beforeFile = join(source, "binary.before"),
    afterFile = join(source, "binary.after");
  await writeFile(beforeFile, before);
  await writeFile(afterFile, after);
  const entry: SessionEntry = {
    type: "message",
    id: "tool-result",
    parentId: null,
    timestamp: new Date().toISOString(),
    message: {
      role: "toolResult",
      toolName: "write",
      toolCallId: "write-binary",
      content: [{ type: "text", text: "partial failure" }],
      isError: true,
      timestamp: Date.now(),
      details: {
        fileChange: {
          path: "binary.bin",
          operation: "modified",
          toolCallId: "write-binary",
          beforeHash: "before",
          afterHash: "after",
          beforeFile,
          afterFile,
        },
      },
    },
  };
  const [copied] = await copyFileChangeSnapshots([entry], source, target);
  const change = entryFileChange(copied);
  expect(change?.failed).toBe(true);
  expect(change?.beforeFile).toBe(join(target, "binary.before"));
  expect(change?.afterFile).toBe(join(target, "binary.after"));
  expect(await readFile(join(target, "binary.before"))).toEqual(before);
  expect(await readFile(join(target, "binary.after"))).toEqual(after);
  expect(entryFileChange(entry)).toMatchObject({ beforeFile, afterFile });
});

test("missing and out-of-bounds legacy patches retain diagnostics without dropping valid changes", async () => {
  const f = await fixture();
  const root = join(f.dir, "snapshots"),
    outside = join(f.dir, "outside.patch");
  await mkdir(root);
  await writeFile(outside, "outside");
  const patch = "--- a/valid.txt\n+++ b/valid.txt\n@@ -1 +1 @@\n-before\n+after\n";
  const changes = await fileChanges(
    [
      {
        path: "missing.txt",
        toolCallId: "missing",
        operation: "modified",
        beforeHash: "before",
        afterHash: "after",
        patchFile: join(root, "missing.patch"),
        failed: true,
      },
      {
        path: "outside.txt",
        toolCallId: "outside",
        operation: "modified",
        beforeHash: "before",
        afterHash: "after",
        patchFile: outside,
      },
      {
        path: "valid.txt",
        toolCallId: "valid",
        operation: "modified",
        beforeHash: "before",
        afterHash: "after",
        patch,
      },
    ],
    root,
    "task",
  );
  expect(changes).toHaveLength(3);
  expect(changes[0]).toMatchObject({ path: "missing.txt", failed: true });
  expect(changes[0].snapshotUnavailable).toBe(true);
  expect(changes[0].reason).toContain("文件快照不可用");
  expect(changes[1].reason).toContain("快照不属于此任务");
  expect(changes[1].snapshotUnavailable).toBe(true);
  expect(changes[2]).toMatchObject({ path: "valid.txt", patch });
  expect(changes[2].snapshotUnavailable).toBeUndefined();
});

test("metadata and inline-budget projections preserve grouping without computing deferred patches", async () => {
  const f = await fixture();
  const root = join(f.dir, "snapshots");
  await mkdir(root);
  const beforeFile = join(root, "before"),
    afterFile = join(root, "after");
  await writeFile(beforeFile, "before\n".repeat(10000));
  await writeFile(afterFile, "after\n".repeat(10000));
  const change: FileChange = {
    path: "large.txt",
    toolCallId: "first",
    operation: "modified",
    beforeHash: "before",
    afterHash: "after",
    beforeFile,
    afterFile,
  };
  const changes: FileChange[] = [
    change,
    { ...change, toolCallId: "last", failed: true },
    { ...change, path: "reverted.txt", afterFile: beforeFile, afterHash: "before" },
    { ...change, path: "missing.txt", afterFile: join(root, "missing") },
    { ...change, path: "legacy.txt", beforeFile: undefined, afterFile: undefined, patch: "+legacy" },
  ];
  for (const options of [{ includePatch: false }, { maxPatchBytes: 64 * 1024 }]) {
    const items = await fileChanges(changes, root, "task", options);
    expect(items.map((item) => item.path)).toEqual(["large.txt", "legacy.txt", "missing.txt"]);
    expect(items[0]).toMatchObject({
      id: "file:large.txt",
      status: "modified",
      failed: true,
      patchAvailable: true,
    });
    expect(items[0].patch).toBeUndefined();
    expect(items[0].reason).toBeUndefined();
    expect(items[2].reason).toContain("文件快照不可用");
    if (options.includePatch === false) {
      expect(items[1].patch).toBeUndefined();
      expect(items[1].patchAvailable).toBe(true);
    } else expect(items[1].patch).toBe("+legacy");
  }
});

test.each([
  ["文件快照不可用：historical fork failure", true],
  ["文件已变化，比对超时", undefined],
  ["无法预览二进制 Diff", undefined],
])(
  "projects snapshot availability independently of other diagnostics: %s",
  async (reason, snapshotUnavailable) => {
    const [item] = await fileChanges(
      [
        {
          path: "file.txt",
          toolCallId: "legacy",
          operation: "modified",
          beforeHash: "before",
          afterHash: "after",
          reason,
        },
      ],
      "/unused",
      "task",
      { includePatch: false },
    );
    expect(item.snapshotUnavailable).toBe(snapshotUnavailable);
  },
);

test("real diff workers preserve large creation patches and remain responsive during expensive comparisons", async () => {
  const f = await fixture();
  const root = join(f.dir, "snapshots");
  await mkdir(root);
  const beforeFile = join(root, "before"),
    afterFile = join(root, "after");
  const before = Array.from({ length: 10000 }, (_, i) => `old row ${i}`).join("\n");
  const after = Array.from({ length: 10000 }, (_, i) => `new row ${i}`).join("\n");
  await writeFile(beforeFile, before);
  await writeFile(afterFile, after);
  const change: FileChange = {
    path: "large.txt",
    toolCallId: "write",
    operation: "created",
    beforeHash: null,
    afterHash: "after",
    afterFile,
  };
  const [created] = await fileChanges([change], root, "task");
  expect(created.patch).toBe(
    createTwoFilesPatch("/dev/null", "large.txt", "", after, "", "", { context: 3 }),
  );
  let ticks = 0;
  const timer = setInterval(() => ticks++, 10);
  try {
    const [modified] = await fileChanges(
      [{ ...change, operation: "modified", beforeHash: "before", beforeFile }],
      root,
      "task",
    );
    expect(modified.reason).toBe("文件已变化，比对超时");
    expect(ticks).toBeGreaterThan(10);
  } finally {
    clearInterval(timer);
  }
});

test("aborting an active diff releases its worker and allows the next request to complete", async () => {
  const f = await fixture();
  const root = join(f.dir, "snapshots");
  await mkdir(root);
  const beforeFile = join(root, "before"),
    afterFile = join(root, "after");
  await writeFile(beforeFile, "old row\n".repeat(10000));
  await writeFile(afterFile, "new row\n".repeat(10000));
  const change: FileChange = {
    path: "large.txt",
    toolCallId: "write",
    operation: "modified",
    beforeHash: "before",
    afterHash: "after",
    beforeFile,
    afterFile,
  };
  const controller = new AbortController();
  const job = fileChanges([change], root, "task", { signal: controller.signal });
  const rejection = expect(job).rejects.toThrow("cancel diff");
  await new Promise((resolve) => setTimeout(resolve, 100));
  controller.abort(new Error("cancel diff"));
  await rejection;
  const [next] = await fileChanges([{ ...change, beforeHash: null, beforeFile: undefined }], root, "task");
  expect(next.patch).toContain("+new row");
});

test("selected file patches only project that file and metadata previews omit patches", async () => {
  const f = await fixture((_body, response, index) => {
    if (index < 3) {
      send(
        response,
        chunk({
          tool_calls: [
            {
              index: 0,
              id: `write-${index}`,
              type: "function",
              function: {
                name: "write",
                arguments: JSON.stringify({
                  path: index === 1 ? "other.txt" : "selected.txt",
                  content: `version ${index}\n`,
                }),
              },
            },
          ],
        }),
      );
      done(response, "tool_calls");
    } else {
      send(response, chunk({ content: "done" }));
      done(response);
    }
  });
  await run(f, "write files");
  const metadata = await f.host.getChanges(f.session.id, null, false);
  expect(metadata).toHaveLength(2);
  expect(metadata.every((entry) => !entry.patch && entry.patchAvailable)).toBe(true);
  const selected = metadata.find((entry) => entry.path.endsWith("selected.txt"));
  if (!selected) throw new Error("selected file missing");
  const project = vi.spyOn(changesModule, "fileChanges");
  try {
    const patch = await f.host.readPatch(f.session.id, null, selected.id);
    expect(patch).toContain("+version 2");
    expect(patch).not.toContain("version 0");
    expect(project).toHaveBeenCalledTimes(1);
    expect(project.mock.calls[0][0]).toHaveLength(2);
    expect(project.mock.calls[0][0].every((entry) => entry.path === selected.path)).toBe(true);
  } finally {
    project.mockRestore();
  }
});

test.each([
  ["created then edited", null, "a\nb\nc\nd\ne\n", "a\n", 1, 0],
  ["edited twice", "original\n", "intermediate\n", "final\n", 1, 1],
  ["restored within the turn", "original\n", "intermediate\n", "original\n", 0, 0],
] as const)(
  "net summary uses first-before and final-after for %s",
  async (_name, original, intermediate, final, added, removed) => {
    const f = await fixture();
    const root = join(f.dir, "summary-snapshots");
    await mkdir(root);
    const beforeFile = join(root, "before");
    const middleFile = join(root, "middle");
    const afterFile = join(root, "after");
    if (original !== null) await writeFile(beforeFile, original);
    await writeFile(middleFile, intermediate);
    await writeFile(afterFile, final);
    const changes: FileChange[] = [
      {
        path: "file.txt",
        toolCallId: "first",
        operation: original === null ? "created" : "modified",
        beforeHash: original === null ? null : "original",
        afterHash: "middle",
        beforeFile: original === null ? undefined : beforeFile,
        afterFile: middleFile,
      },
      {
        path: "file.txt",
        toolCallId: "second",
        operation: "modified",
        beforeHash: "middle",
        afterHash: "final",
        beforeFile: middleFile,
        afterFile,
      },
    ];
    const items = await fileChanges(changes, root, "本轮变更", {
      includePatch: false,
      includeStats: true,
      maxPatchBytes: 1,
    });
    if (!added && !removed) expect(items).toEqual([]);
    else {
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({ path: "file.txt", added, removed, patchAvailable: true });
      expect(items[0].patch).toBeUndefined();
    }
  },
);
