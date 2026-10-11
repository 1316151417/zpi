import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { emptyAssistant } from "zpi-ai";
import { buildSessionMentionMarkdown, SessionManager } from "zpi-coding-agent";
import { chunk, done, fakeModel, send } from "../../../tests/fake-server.ts";
import { SessionHost } from "../src/main/session-host.ts";
import { sessionReferenceTranscript } from "../src/main/session-references.ts";
import { cleanup, fixture } from "./helpers/host-fixture.ts";

it("lists persisted cross-project conversations current workspace first, excluding drafts, side chats and archived sessions", async () => {
  const f = await fixture((_, response) => {
    send(response, chunk({ content: "ok" }));
    done(response);
  });
  const current = f.host.createSession(f.a.id);
  const local = f.host.createSession(f.a.id);
  const other = f.host.createSession(f.b.id);
  for (const session of [local, other]) {
    await f.host.startRun({ sessionId: session.id, text: "history" });
    await f.host.activeRuns.get(session.id)?.done;
  }
  f.host.renameSession(local.id, "A [中文]");
  f.host.renameSession(other.id, "B newer");
  f.host.createSession(f.a.id);
  const side = await f.host.createSideChat(local.id);
  await f.host.startRun({ sessionId: side.id, text: "side history" });
  await f.host.activeRuns.get(side.id)?.done;
  const catalog = f.host.listSessionMentions(current.id);
  expect(catalog.map((item) => item.sessionId)).toEqual([local.id, other.id]);
  expect(catalog[0]).toMatchObject({
    name: "A [中文]",
    description: "a",
    insert: `[#A \\[中文\\]](#${local.id}) `,
    group: "对话",
  });
  await f.host.archiveSession(local.id);
  expect(f.host.listSessionMentions(current.id).map((item) => item.sessionId)).toEqual([other.id]);
  expect(() => f.host.listSessionMentions("../invalid")).toThrow("not_found");
});

it("sends only a lightweight reminder and reads a clean immutable snapshot on demand using the existing read tool", async () => {
  const f = await fixture((body, response) => {
    const messages = body.messages as { role: string; content: string }[];
    const lastUser = messages.filter((message) => message.role === "user").at(-1)?.content ?? "";
    const path = /- [a-f\d-]+: ("[^\n]+")/.exec(lastUser)?.[1];
    if (path && messages.at(-1)?.role !== "tool") {
      send(
        response,
        chunk({
          tool_calls: [
            {
              index: 0,
              id: "read-context",
              type: "function",
              function: { name: "read", arguments: JSON.stringify({ path: JSON.parse(path) }) },
            },
          ],
        }),
      );
      done(response, "tool_calls");
    } else {
      send(response, chunk({ content: path ? "context used" : "source-history-marker" }));
      done(response);
    }
  });
  const source = f.host.createSession(f.b.id);
  await f.host.startRun({ sessionId: source.id, text: "source-user-marker" });
  await f.host.activeRuns.get(source.id)?.done;
  const current = f.host.createSession(f.a.id);
  const text = `${buildSessionMentionMarkdown(source.id, "Earlier conversation")} continue`;
  await f.host.startRun({ sessionId: current.id, text });
  await f.host.activeRuns.get(current.id)?.done;
  const requests = f.server.requests.filter((request) =>
    JSON.stringify(request.messages).includes("Referenced session context:"),
  );
  expect(requests).toHaveLength(2);
  const initial = requests[0].messages as { role: string; content: string }[];
  expect(JSON.stringify(initial)).not.toContain("source-history-marker");
  expect(JSON.stringify(initial)).not.toContain("source-user-marker");
  const reminder = initial.filter((message) => message.role === "user").at(-1)?.content ?? "";
  const path = JSON.parse(/- [a-f\d-]+: ("[^\n]+")/.exec(reminder)?.[1] ?? '""') as string;
  const snapshot = await readFile(path, "utf8");
  expect(snapshot).toContain("source-user-marker");
  expect(snapshot).toContain("source-history-marker");
  expect(snapshot).not.toContain("<system_rules>");
  expect(snapshot).not.toContain("secret-host");
  expect((await stat(path)).mode & 0o777).toBe(0o600);
  expect(JSON.stringify(requests[1].messages)).toContain("source-history-marker");
  expect(
    (requests[0].tools as { function: { name: string } }[]).map((tool) => tool.function.name),
  ).not.toContain("ReadSessionContext");
  expect(f.host.getSessionSnapshot(current.id).view.runs[0].userMessage).toBe(text);
  f.host.saveDraft(current.id, {
    text,
    fileReferences: [],
    selections: [],
    selection: [text.length, text.length],
    revision: 1,
  });
  expect((await f.host.getDraft(current.id)).warnings).toEqual([]);
  await f.host.close();
  const restored = new SessionHost(f.dir, f.settings, join(f.dir, "agent"), undefined, undefined);
  await restored.init();
  cleanup.push(() => restored.close());
  expect(restored.getSessionSnapshot(current.id).view.runs[0].userMessage).toBe(text);
  const continued = `${buildSessionMentionMarkdown(source.id, "Renamed display")} next`;
  await restored.startRun({ sessionId: current.id, text: continued });
  await restored.activeRuns.get(current.id)?.done;
  expect(await readdir(join(f.dir, "agent", "session-context", source.id))).toHaveLength(1);
  expect(await readFile(path, "utf8")).toBe(snapshot);
  const runId = restored.getSessionSnapshot(current.id).view.runs.at(-1)?.runId as string;
  const fork = await restored.forkSession(current.id, runId);
  await restored.deleteSession(current.id);
  expect(await readFile(path, "utf8")).toBe(snapshot);
  await restored.startRun({ sessionId: fork.id, text: "resume the fork" });
  await restored.activeRuns.get(fork.id)?.done;
  expect(JSON.stringify(f.server.requests.at(-1)?.messages)).toContain(path);
  restored.saveDraft(fork.id, {
    text,
    fileReferences: [],
    selection: [text.length, text.length],
    revision: 1,
  });
  await restored.deleteSession(source.id);
  expect((await restored.getDraft(fork.id)).warnings).toEqual([`引用已失效，原文已保留：#${source.id}`]);
  expect((await restored.getDraft(fork.id)).text).toBe(text);
  await restored.deleteSession(fork.id);
  await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
});

it("reports missing, deleted and self references without inventing history or blocking the current request", async () => {
  const f = await fixture((_, response) => {
    send(response, chunk({ content: "ok" }));
    done(response);
  });
  const current = f.host.createSession(f.a.id);
  await f.host.startRun({ sessionId: current.id, text: `#sess_missing #${current.id} continue` });
  await f.host.activeRuns.get(current.id)?.done;
  expect(JSON.stringify(f.server.requests.at(-1)?.messages)).toContain(
    "sess_missing: session context unavailable",
  );
  await expect(stat(join(f.dir, "agent", "session-context", current.id))).rejects.toMatchObject({
    code: "ENOENT",
  });
});

it("degrades an unreadable reference snapshot without blocking the user's current task", async () => {
  const f = await fixture((_, response) => {
    send(response, chunk({ content: "ok" }));
    done(response);
  });
  const source = f.host.createSession(f.b.id);
  await f.host.startRun({ sessionId: source.id, text: "source history" });
  await f.host.activeRuns.get(source.id)?.done;
  const root = join(f.dir, "agent", "session-context");
  await mkdir(root, { recursive: true });
  await writeFile(join(root, source.id), "not a directory");
  const current = f.host.createSession(f.a.id);
  await f.host.startRun({
    sessionId: current.id,
    text: `${buildSessionMentionMarkdown(source.id, "Source")} continue`,
  });
  await f.host.activeRuns.get(current.id)?.done;
  expect(f.host.getSessionSnapshot(current.id).view.runs[0].status).toBe("completed");
  expect(JSON.stringify(f.server.requests.at(-1)?.messages)).toContain(
    `${source.id}: session context unavailable`,
  );
});

it("excludes internal user context, system instructions, reasoning and metadata, while bounding long transcripts", () => {
  const manager = SessionManager.inMemory();
  manager.appendCustomEntry("zpi.run", { phase: "start", text: "visible input" });
  manager.appendMessage({ role: "user", content: "internal prepared context", timestamp: 1 });
  manager.appendMessage({ role: "system", content: "secret system declaration", timestamp: 1 });
  const assistant = emptyAssistant(fakeModel("http://localhost"));
  manager.appendMessage({
    ...assistant,
    content: [
      { type: "thinking", thinking: "private reasoning" },
      { type: "text", text: "visible response" },
      { type: "text", text: "<system-reminder>internal reminder</system-reminder>" },
      { type: "toolCall", id: "context-tool", name: "read", arguments: { path: "README.md" } },
    ],
  });
  manager.appendMessage({
    role: "toolResult",
    toolCallId: "context-tool",
    toolName: "read",
    content: [{ type: "text", text: "visible tool result" }],
    isError: false,
    timestamp: 1,
  });
  manager.appendCustomEntry("zpi.configuration", { secret: "credential" });
  const clean = sessionReferenceTranscript("Title", "sess_source", manager.getEntries());
  expect(clean).toContain("visible input");
  expect(clean).toContain("visible response");
  expect(clean).toContain("Tool read");
  expect(clean).toContain("README.md");
  expect(clean).toContain("visible tool result");
  expect(clean).not.toContain("internal reminder");
  for (const internal of [
    "internal prepared context",
    "secret system declaration",
    "private reasoning",
    "credential",
  ])
    expect(clean).not.toContain(internal);
  for (let n = 0; n < 20; n++)
    manager.appendMessage({ ...assistant, content: [{ type: "text", text: `${n}: ${"x".repeat(20000)}` }] });
  const bounded = sessionReferenceTranscript("Title", "sess_source", manager.getEntries());
  expect(bounded.length).toBeLessThan(128500);
  expect(bounded).toContain("Earlier history omitted");
  expect(bounded).toContain("Message truncated");
  expect(bounded).toContain("19: ");
});
