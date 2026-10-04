import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { chunk, done, send } from "../../../tests/fake-server.ts";
import { fileChanges } from "../src/main/file-changes.ts";
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
  f.host.saveDraft(f.session.id, { text: "未发送草稿", fileReferences: [], selection: [3, 3], revision: 1 });
  f.host.archiveSession(f.session.id);
  expect(f.host.listRecentSessions().some((record) => record.id === f.session.id)).toBe(false);
  await f.host.close();
  const reopened = new SessionHost(f.dir, f.settings, f.resources, f.workspace, undefined, []);
  await reopened.init();
  cleanup.push(() => reopened.close());
  expect(reopened.listRecentSessions().some((record) => record.id === f.session.id)).toBe(false);
  expect((await reopened.getDraft(f.session.id)).text).toBe("未发送草稿");
  expect((await reopened.getChanges(f.session.id, null))[0].patch).toBe(entries[0].patch);
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
