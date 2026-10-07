import type { SessionEntry } from "ZPI-coding-agent";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { chunk, done, send } from "../../../tests/fake-server.ts";
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
  const runId = f.host.getSessionSnapshot(f.session.id).view.runs[0].runId;
  expect((await f.host.getChanges(f.session.id, runId))[0].patch).toBe(entries[0].patch);
  expect(await f.host.readPatch(f.session.id, null, entries[0].id)).toBe(entries[0].patch);
  const first = await f.host.readPatch(f.session.id, runId, "operation:write-0");
  const second = await f.host.readPatch(f.session.id, runId, "operation:write-1");
  expect(first).toContain("-original");
  expect(first).toContain("+intermediate");
  expect(first).not.toContain("+final");
  expect(second).toContain("-intermediate");
  expect(second).toContain("+final");
  expect(second).not.toContain("-original");
  await expect(f.host.readPatch(f.session.id, runId, "operation:missing")).rejects.toThrow("not_found");
  const otherSession = f.host.createSession(null);
  await expect(f.host.readPatch(otherSession.id, null, "operation:write-0")).rejects.toThrow("not_found");
  f.host.saveDraft(f.session.id, { text: "未发送草稿", fileReferences: [], selection: [3, 3], revision: 1 });
  await f.host.archiveSession(f.session.id);
  expect(f.host.listRecentSessions().some((record) => record.id === f.session.id)).toBe(false);
  await f.host.close();
  const reopened = new SessionHost(f.dir, f.settings, f.resources, f.workspace, undefined, []);
  await reopened.init();
  cleanup.push(() => reopened.close());
  expect(reopened.listRecentSessions().some((record) => record.id === f.session.id)).toBe(false);
  expect((await reopened.getDraft(f.session.id)).text).toBe("未发送草稿");
  expect((await reopened.getChanges(f.session.id, null))[0].patch).toBe(entries[0].patch);
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
    if (allowed) expect(item.patch).toContain("+inside");
    else {
      expect(item.patch).toBeUndefined();
      expect(item.reason).toContain("快照不属于此任务");
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
  expect(changes[0].reason).toContain("文件快照不可用");
  expect(changes[1].reason).toContain("快照不属于此任务");
  expect(changes[2]).toMatchObject({ path: "valid.txt", patch });
});
