import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { chunk, deferred, done, send } from "../../../tests/fake-server.ts";
import { SessionHost } from "../src/main/session-host.ts";
import { fixture as contextFixture, png, run } from "./helpers/context-fixture.ts";
import { cleanup, fixture } from "./helpers/host-fixture.ts";

it("fork copies only the chosen completed boundary, retains context after restart and leaves parent history unchanged", async () => {
  const f = await fixture((_, res) => {
    send(res, chunk({ content: "answer" }));
    done(res);
  });
  const parent = f.host.createSession(f.a.id);
  const first = await f.host.startRun({ sessionId: parent.id, text: "first" });
  await f.host.activeRuns.get(parent.id)?.done;
  await f.host.startRun({ sessionId: parent.id, text: "second" });
  await f.host.activeRuns.get(parent.id)?.done;
  const path = join(f.dir, "agent", "sessions", f.a.id, `${parent.id}.jsonl`);
  const before = await readFile(path, "utf8");
  const child = await f.host.forkSession(parent.id, first.runId);
  expect(child.projectId).toBe(parent.projectId);
  expect(f.host.getSessionSnapshot(child.id).view.forkOrigin).toEqual({
    sessionId: parent.id,
    runId: first.runId,
  });
  expect(f.host.getSessionSnapshot(child.id).view.runs.map((run) => run.userMessage)).toEqual(["first"]);
  expect(await readFile(path, "utf8")).toBe(before);
  await f.host.close();
  const restored = new SessionHost(f.dir, f.settings, join(f.dir, "agent"), undefined, undefined, []);
  await restored.init();
  cleanup.push(() => restored.close());
  expect(restored.getSessionSnapshot(child.id).view.runs.map((run) => run.userMessage)).toEqual(["first"]);
  await restored.startRun({ sessionId: child.id, text: "child input" });
  await restored.activeRuns.get(child.id)?.done;
  const messages = JSON.stringify(f.server.requests.at(-1)?.messages);
  expect(messages).toContain("first");
  expect(messages).toContain("answer");
  expect(messages).toContain("child input");
  expect(messages).not.toContain("second");
  expect(restored.getSessionSnapshot(parent.id).view.runs).toHaveLength(2);
});

it("forked images remain independently readable even when history contains more than eight images and parent is deleted", async () => {
  const f = await contextFixture();
  const images: string[] = [];
  for (let i = 0; i < 9; i++) {
    const image = await f.host.importImage(f.session.id, `${i}.png`, await png());
    images.push(image.id);
    await run(f, `image ${i}`, { attachments: [image.id] });
  }
  const last = f.host.getSessionSnapshot(f.session.id).view.runs.at(-1);
  if (!last) throw new Error("missing turn");
  const child = await f.host.forkSession(f.session.id, last.runId);
  await f.host.deleteSession(f.session.id);
  for (const id of images) expect((await f.host.readAttachment(child.id, id)).data).toBeTruthy();
  await f.host.startRun({ sessionId: child.id, text: "continue with images" });
  await f.host.activeRuns.get(child.id)?.done;
  expect(JSON.stringify(f.server.requests.at(-1))).toContain("data:image/png;base64,");
});

it("file reset rejects external changes without pruning history, restores original files and keeps fork snapshots independent", async () => {
  const f = await fixture((_, res, index) => {
    if (index === 0) {
      send(
        res,
        chunk({
          tool_calls: [
            {
              index: 0,
              id: "modify",
              type: "function",
              function: {
                name: "write",
                arguments: JSON.stringify({ path: "existing.txt", content: "agent\n" }),
              },
            },
            {
              index: 1,
              id: "create",
              type: "function",
              function: {
                name: "write",
                arguments: JSON.stringify({ path: "created.txt", content: "new\n" }),
              },
            },
          ],
        }),
      );
      done(res, "tool_calls");
    } else {
      send(res, chunk({ content: "complete" }));
      done(res);
    }
  });
  const parent = f.host.createSession(f.a.id);
  const existing = join(f.a.path, "existing.txt"),
    created = join(f.a.path, "created.txt");
  await writeFile(existing, "original\n");
  const first = await f.host.startRun({ sessionId: parent.id, text: "change files" });
  await f.host.activeRuns.get(parent.id)?.done;
  const child = await f.host.forkSession(parent.id, first.runId);
  const changes = await f.host.getChanges(child.id, null);
  expect(changes).toHaveLength(2);
  expect(changes.find((change) => change.path === existing)?.patch).toContain("-original");
  await writeFile(existing, "external\n");
  const result = await f.host.editUserMessage(parent.id, first.runId, {
    text: "retry",
    workspaceMode: "rewind",
  });
  expect(result).toMatchObject({ conflicts: [{ path: existing, reason: "当前文件已被外部修改" }] });
  expect(f.host.getSessionSnapshot(parent.id).view.runs[0].userMessage).toBe("change files");
  expect(await readFile(existing, "utf8")).toBe("external\n");
  expect(existsSync(created)).toBe(true);
  await writeFile(existing, "agent\n");
  await f.host.editUserMessage(parent.id, first.runId, { text: "retry", workspaceMode: "rewind" });
  await f.host.activeRuns.get(parent.id)?.done;
  expect(await readFile(existing, "utf8")).toBe("original\n");
  expect(existsSync(created)).toBe(false);
  expect(f.host.getSessionSnapshot(parent.id).view.runs.map((turn) => turn.userMessage)).toEqual(["retry"]);
  await f.host.deleteSession(parent.id);
  expect(await f.host.getChanges(child.id, null)).toEqual(changes);
});

it("editing only the latest user input stops its running reply, removes old context and preserves a paused queue", async () => {
  const arrived = deferred(),
    release = deferred();
  cleanup.push(async () => release.resolve());
  const f = await fixture(async (_, res, index) => {
    send(res, chunk({ content: "answer" }));
    if (index === 1) {
      arrived.resolve();
      await release.promise;
    }
    done(res);
  });
  const session = f.host.createSession(f.a.id);
  const first = await f.host.startRun({ sessionId: session.id, text: "first" });
  await f.host.activeRuns.get(session.id)?.done;
  const second = await f.host.startRun({ sessionId: session.id, text: "old latest" });
  await arrived.promise;
  await f.host.submitInput({ sessionId: session.id, text: "queued" });
  await expect(f.host.editUserMessage(session.id, first.runId, { text: "invalid old edit" })).rejects.toThrow(
    "最新",
  );
  expect(f.host.activeRuns.get(session.id)?.runId).toBe(second.runId);
  await expect(
    f.host.editUserMessage(session.id, second.runId, { text: "new", attachments: ["missing"] }),
  ).rejects.toThrow();
  expect(f.host.activeRuns.get(session.id)?.runId).toBe(second.runId);
  await f.host.editUserMessage(session.id, second.runId, {
    text: "replacement",
    attachments: [],
    fileReferences: [],
  });
  await f.host.activeRuns.get(session.id)?.done;
  release.resolve();
  const snapshot = f.host.getSessionSnapshot(session.id);
  expect(snapshot.view.runs.map((run) => run.userMessage)).toEqual(["first", "replacement"]);
  expect(snapshot.view.queue?.items.map((item) => item.text)).toEqual(["queued"]);
  expect(JSON.stringify(f.server.requests.at(-1)?.messages)).not.toContain("old latest");
  expect(JSON.stringify(f.server.requests.at(-1)?.messages)).toContain("first");
  await f.host.close();
  const restored = new SessionHost(f.dir, f.settings, join(f.dir, "agent"), undefined, undefined, []);
  await restored.init();
  cleanup.push(() => restored.close());
  expect(restored.getSessionSnapshot(session.id).view.runs.map((run) => run.userMessage)).toEqual([
    "first",
    "replacement",
  ]);
  expect(restored.getSessionSnapshot(session.id).session.title).toBe(snapshot.session.title);
});

it("forking an older reply leaves a concurrent parent running and rejects an unfinished boundary", async () => {
  const release = deferred(),
    arrived = deferred();
  cleanup.push(async () => release.resolve());
  const f = await fixture(async (_, res, index) => {
    send(res, chunk({ content: "answer" }));
    if (index === 1) {
      arrived.resolve();
      await release.promise;
    }
    done(res);
  });
  const parent = f.host.createSession(f.a.id);
  const first = await f.host.startRun({ sessionId: parent.id, text: "first" });
  await f.host.activeRuns.get(parent.id)?.done;
  const running = await f.host.startRun({ sessionId: parent.id, text: "running" });
  await arrived.promise;
  await expect(f.host.forkSession(parent.id, running.runId)).rejects.toThrow("结束");
  const child = await f.host.forkSession(parent.id, first.runId);
  expect(f.host.activeRuns.get(parent.id)?.runId).toBe(running.runId);
  expect(f.host.getSessionSnapshot(child.id).view.runs).toHaveLength(1);
  release.resolve();
  await f.host.activeRuns.get(parent.id)?.done;
});

it("file reset blocks shell side effects and preserves history and workspace until conversation-only resubmit", async () => {
  const f = await fixture((_, res, index) => {
    const tool =
      index === 0
        ? { name: "write", arguments: { path: "changed.txt", content: "agent" } }
        : index === 1
          ? { name: "bash", arguments: { command: "printf shell > changed.txt" } }
          : undefined;
    if (tool) {
      send(
        res,
        chunk({
          tool_calls: [
            {
              index: 0,
              id: `call-${index}`,
              type: "function",
              function: { name: tool.name, arguments: JSON.stringify(tool.arguments) },
            },
          ],
        }),
      );
      done(res, "tool_calls");
    } else {
      send(res, chunk({ content: "done" }));
      done(res);
    }
  });
  const parent = f.host.createSession(f.a.id),
    path = join(f.a.path, "changed.txt");
  await writeFile(path, "original");
  const turn = await f.host.startRun({ sessionId: parent.id, text: "write through shell" });
  await f.host.activeRuns.get(parent.id)?.done;
  expect(
    await f.host.editUserMessage(parent.id, turn.runId, { text: "retry", workspaceMode: "rewind" }),
  ).toEqual({ conflicts: [{ path: "bash/shell", reason: "bash/shell 修改已忽略", ignored: true }] });
  expect(await readFile(path, "utf8")).toBe("shell");
  expect(f.host.getSessionSnapshot(parent.id).view.runs[0].userMessage).toBe("write through shell");
  await f.host.editUserMessage(parent.id, turn.runId, { text: "retry" });
  await f.host.activeRuns.get(parent.id)?.done;
  expect(f.host.getSessionSnapshot(parent.id).view.runs[0].userMessage).toBe("retry");
  expect(await readFile(path, "utf8")).toBe("shell");
});
