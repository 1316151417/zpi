import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readLegacySession, recoveredQueue } from "../../../scripts/storage-migration/legacy.ts";
import {
  activate,
  convert,
  inspect,
  inventory,
  savePlan,
  validate,
} from "../../../scripts/storage-migration/workflow.ts";
import { StateStore } from "../src/main/state-store.ts";
import { readActiveGeneration } from "../src/main/storage-generation.ts";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture(rows: Record<string, unknown>[] = []) {
  const root = await mkdtemp(join(tmpdir(), "zpi-migration-"));
  roots.push(root);
  const source = join(root, "source"),
    target = join(root, "target");
  const path = join(source, "agent", "sessions", "_unassigned", "task.jsonl");
  await mkdir(join(source, "agent", "sessions", "_unassigned"), { recursive: true });
  const header = {
    type: "session",
    version: 1,
    format: "zpi",
    id: "task",
    cwd: "/external/project",
    timestamp: "2026-01-01T00:00:00.000Z",
  };
  let parentId: string | null = null;
  const entries = rows.map((row, i) => {
    const entry = { id: `e${i}`, timestamp: "2026-01-01T00:00:00.000Z", parentId, ...row };
    parentId = entry.id;
    return entry;
  });
  await writeFile(path, `${[header, ...entries].map((entry) => JSON.stringify(entry)).join("\n")}\n`);
  return { root, source, target, path };
}
const userMessage = { type: "message", message: { role: "user", content: "hello 世界", timestamp: 1 } };
describe("offline storage migration", () => {
  it("keeps source bytes unchanged through inspect/convert/validate/activate", async () => {
    const f = await fixture([userMessage]);
    const before = await inventory(f.source);
    const plan = await savePlan(f.source, join(f.root, "plan.json"));
    expect(plan.blockers).toEqual([]);
    const stage = await convert(plan, f.target, true);
    await validate(stage);
    expect(readActiveGeneration(f.target)).toBeUndefined();
    const ready = await activate(plan, f.target, true);
    expect(readActiveGeneration(f.target)?.directory).toBe(ready);
    expect(await activate(plan, f.target, true)).toBe(ready);
    expect(await inventory(f.source)).toEqual(before);
    const output = (await readFile(join(ready, "agent/sessions/_unassigned/task.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(output[0].version).toBe(2);
    expect(output[1].id).toBe("e0");
    expect(output[1].message).toEqual(userMessage.message);
  });
  it("deduplicates all accepted queue IDs, including earlier runs, and pauses the rest", async () => {
    const f = await fixture([
      { type: "custom", customType: "zpi.run", data: { phase: "start", runId: "r1", queueItemId: "q1" } },
      { type: "custom", customType: "zpi.run", data: { phase: "end", runId: "r1", status: "completed" } },
      { type: "custom", customType: "zpi.run", data: { phase: "start", runId: "r2", queueItemId: "q2" } },
      {
        type: "custom",
        customType: "zpi.queue",
        data: {
          items: [{ id: "q1" }, { id: "q2" }, { id: "q3", state: "dispatching", text: "pending" }],
          autoDrain: true,
        },
      },
    ]);
    const session = await readLegacySession(f.path);
    try {
      expect(recoveredQueue(session)).toEqual({
        items: [{ id: "q3", state: "queued", text: "pending" }],
        autoDrain: false,
        pauseReason: "restart",
      });
    } finally {
      session.close();
    }
  });
  it("blocks unknown semantics and never invokes repair on damaged source", async () => {
    const f = await fixture([{ type: "custom", customType: "extension.unknown", data: {} }]);
    const before = await readFile(f.path);
    expect((await inspect(f.source)).blockers[0].reason).toContain("unknown custom semantic");
    await writeFile(f.path, Buffer.concat([before, Buffer.from('{"id":')]));
    const damaged = await readFile(f.path);
    expect((await inspect(f.source)).blockers[0].reason).toContain("unknown custom semantic");
    expect(await readFile(f.path)).toEqual(damaged);
  });
  it("refuses changed source, absent offline confirmation, overlapping paths and corrupt target", async () => {
    const f = await fixture([userMessage]);
    const plan = await inspect(f.source);
    await expect(convert(plan, f.target)).rejects.toThrow("offline");
    await expect(convert(plan, join(f.source, "nested"), true)).rejects.toThrow("disjoint");
    const stage = await convert(plan, f.target, true);
    await writeFile(join(stage, "agent/sessions/_unassigned/task.jsonl"), "tampered");
    await expect(validate(stage)).rejects.toThrow("fingerprint");
    await writeFile(f.path, "changed");
    await expect(activate(plan, f.target, true)).rejects.toThrow("source fingerprint");
  });
  it("copies encrypted credentials without parsing and interrupts last running task", async () => {
    const f = await fixture([
      { type: "custom", customType: "zpi.run", data: { phase: "start", runId: "r1", text: "original" } },
    ]);
    const bytes = Buffer.from([0, 255, 19, 7]);
    await writeFile(join(f.source, "credentials.enc"), bytes);
    const plan = await inspect(f.source);
    const stage = await convert(plan, f.target, true);
    expect(await readFile(join(stage, "credentials.enc"))).toEqual(bytes);
    const store = new StateStore(join(stage, "state.sqlite"));
    try {
      expect(store.getTask("task")?.status).toBe("interrupted");
    } finally {
      store.close();
    }
  });
});

it("migrates settings into the runtime app key, preserving legacy preferences", async () => {
  const f = await fixture([userMessage]);
  await writeFile(
    join(f.source, "settings.json"),
    JSON.stringify({ version: 4, providers: [], interface: { theme: "dark", fontSize: "large" } }),
  );
  const plan = await inspect(f.source);
  expect(plan.blockers).toEqual([]);
  const stage = await convert(plan, f.target, true);
  const store = new StateStore(join(stage, "state.sqlite"));
  try {
    const { SettingsStore } = await import("../src/main/storage.ts");
    const settings = new SettingsStore(
      stage,
      {
        isEncryptionAvailable: () => false,
        encryptString: () => {
          throw new Error("unused");
        },
        decryptString: () => {
          throw new Error("unused");
        },
      },
      store,
    );
    expect(settings.get().interface).toMatchObject({ theme: "dark", fontSize: 16 });
  } finally {
    store.close();
  }
});

it("preserves attachments, queue, drafts, compaction, diagnostics and background state", async () => {
  const f = await fixture();
  const attachment = join(f.source, "agent", "attachments", "task", "payload.file");
  await mkdir(join(f.source, "agent", "attachments", "task"), { recursive: true });
  await writeFile(attachment, Buffer.from([0, 255, 13]));
  await writeFile(
    join(f.source, "agent", "attachments", "task", "index.json"),
    JSON.stringify([{ id: "payload", path: attachment, name: "a", used: false }]),
  );
  const header = JSON.parse((await readFile(f.path, "utf8")).trim());
  const rows = [
    { type: "message", message: { role: "system", content: "system", timestamp: 1 } },
    userMessage,
    { type: "compaction", summary: "summary", firstKeptEntryId: "e1", tokensBefore: 10 },
    { type: "custom", customType: "zpi.notice", data: { text: "diagnostic", runId: "r" } },
    {
      type: "custom",
      customType: "zpi.queue",
      data: { items: [{ id: "q", text: "pending", attachments: [{ path: attachment }] }], autoDrain: true },
    },
    {
      type: "custom",
      customType: "zpi.background_task:b",
      data: { taskId: "b", sessionId: "task", status: "running", outputPath: attachment },
    },
  ];
  await writeFile(
    f.path,
    `${[
      header,
      ...rows.map((row, i) => ({
        id: `e${i}`,
        parentId: i ? `e${i - 1}` : null,
        timestamp: header.timestamp,
        ...row,
      })),
    ]
      .map((row) => JSON.stringify(row))
      .join("\n")}\n`,
  );
  await mkdir(join(f.source, "drafts"));
  await writeFile(
    join(f.source, "drafts", "task.json"),
    JSON.stringify({ text: "draft", revision: 2, selection: [0, 0], fileReferences: [attachment] }),
  );
  const plan = await inspect(f.source);
  expect(plan.blockers).toEqual([]);
  const stage = await convert(plan, f.target, true);
  const final = join(f.target, "storage", plan.migrationId);
  const store = new StateStore(join(stage, "state.sqlite"));
  try {
    expect(store.getQueue("task")?.items[0]).toMatchObject({
      attachments: [{ path: join(final, "agent/attachments/task/payload.file") }],
    });
    expect(store.getDraft("task")).toMatchObject({
      text: "draft",
      fileReferences: [join(final, "agent/attachments/task/payload.file")],
    });
    expect(store.getRuntime("task", "background")[0]).toMatchObject({ status: "lost" });
    expect(store.getTask("task")?.sessionFile).toBe("agent/sessions/_unassigned/task.jsonl");
  } finally {
    store.close();
  }
  expect(await readFile(join(stage, "agent/attachments/task/payload.file"))).toEqual(
    Buffer.from([0, 255, 13]),
  );
  const output = (await readFile(join(stage, "agent/sessions/_unassigned/task.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(output.find((row) => row.type === "compaction").systemMessage.content).toBe("system\n\n");
  expect(output.find((row) => row.type === "diagnostic").fact.text).toBe("diagnostic");
});

it("materializes interrupted streaming journals once without executing tools", async () => {
  const { emptyAssistant } = await import("zpi-ai");
  const { fakeModel } = await import("../../../tests/fake-server.ts");
  const assistant = {
    ...emptyAssistant(fakeModel("")),
    content: [{ type: "toolCall", id: "call", name: "bash", arguments: { command: "never execute" } }],
  };
  const f = await fixture([
    userMessage,
    {
      type: "custom",
      customType: "zpi.streaming_tools",
      data: { id: "journal", anchorId: "e0", assistant, results: [] },
    },
  ]);
  const before = await inventory(f.source);
  const plan = await inspect(f.source);
  expect(plan.blockers).toEqual([]);
  const stage = await convert(plan, f.target, true);
  const output = (await readFile(join(stage, "agent/sessions/_unassigned/task.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(output.filter((row) => row.message?.role === "assistant")).toHaveLength(1);
  expect(output.filter((row) => row.message?.role === "toolResult")).toHaveLength(1);
  expect(output.find((row) => row.message?.role === "toolResult").message).toMatchObject({
    isError: true,
    details: { reason: "unknown_execution_state" },
  });
  expect(output.filter((row) => row.type === "tool_journal" && row.fact.committed)).toHaveLength(1);
  await validate(stage);
  expect(await inventory(f.source)).toEqual(before);
});

it("preserves child relationships and subagent last-known state without restarting work", async () => {
  const f = await fixture([userMessage]);
  const child = join(f.source, "agent/sessions/_unassigned/child.jsonl");
  const time = "2026-01-01T00:00:00.000Z";
  await writeFile(
    child,
    [
      { type: "session", version: 1, format: "zpi", id: "child", cwd: "/external/project", timestamp: time },
      {
        type: "custom",
        id: "c0",
        parentId: null,
        timestamp: time,
        customType: "zpi.environment",
        data: { parentSessionId: "task" },
      },
      {
        type: "custom",
        id: "c1",
        parentId: "c0",
        timestamp: time,
        customType: "zpi.subagent_task",
        data: {
          agentId: "a",
          parentSessionId: "task",
          childSessionId: "child",
          status: "running",
          waitingForInput: true,
        },
      },
    ]
      .map((row) => JSON.stringify(row))
      .join("\n"),
  );
  const plan = await inspect(f.source);
  expect(plan.blockers).toEqual([]);
  const stage = await convert(plan, f.target, true);
  const store = new StateStore(join(stage, "state.sqlite"));
  try {
    expect(store.getTask("child")?.parentSessionId).toBe("task");
    expect(store.getRuntime("child", "subagent")[0]).toMatchObject({
      status: "interrupted",
      instanceId: "a",
      data: { waitingForInput: false },
    });
  } finally {
    store.close();
  }
});

it("copies app-owned profiles and SDK settings but inventories unrelated Electron data as omitted", async () => {
  const f = await fixture();
  await mkdir(join(f.source, "agents"));
  await writeFile(join(f.source, "agents", "reviewer.md"), "user profile\n");
  await writeFile(
    join(f.source, "agents-state.json"),
    JSON.stringify({ disabled: ["reviewer"], overrides: {} }),
  );
  await writeFile(join(f.source, "agent", "settings.json"), JSON.stringify({ retry: { maxRetries: 7 } }));
  const { symlink } = await import("node:fs/promises");
  await symlink("missing-browser-socket", join(f.source, "SingletonSocket"));
  const plan = await inspect(f.source);
  expect(plan.blockers).toEqual([]);
  expect(plan.omittedRootEntries).toEqual(["SingletonSocket"]);
  const stage = await convert(plan, f.target, true);
  for (const name of ["agents/reviewer.md", "agent/settings.json"])
    expect(await readFile(join(stage, name))).toEqual(await readFile(join(f.source, name)));
  const store = new StateStore(join(stage, "state.sqlite"));
  try {
    expect(store.getSetting("subagentProfiles")).toEqual({ disabled: ["reviewer"], overrides: {} });
  } finally {
    store.close();
  }
});

it("moves fork and current choices into authoritative task state, retaining neutral anchors", async () => {
  const f = await fixture([
    { type: "session_info", name: "Title" },
    { type: "model_change", provider: "p", modelId: "old" },
    { type: "thinking_level_change", thinkingLevel: "high" },
    {
      type: "custom",
      customType: "zpi.selection",
      data: { provider: "p", modelId: "new", reasoning: "off" },
    },
    { type: "custom", customType: "zpi.fork", data: { parentSessionId: "original", runId: "r" } },
    userMessage,
  ]);
  const plan = await inspect(f.source);
  expect(plan.blockers).toEqual([]);
  const stage = await convert(plan, f.target, true);
  const store = new StateStore(join(stage, "state.sqlite"));
  try {
    expect(store.getTask("task")).toMatchObject({
      title: "Title",
      lastThinkingLevel: "high",
      currentSelection: { modelId: "new" },
      fork: { sessionId: "original", runId: "r" },
    });
  } finally {
    store.close();
  }
  const output = await readFile(join(stage, "agent/sessions/_unassigned/task.jsonl"), "utf8");
  expect(output).not.toContain('"type":"fork"');
  expect(output).toContain('"historyConfiguration"');
});

it("spools record identity and accepted queue IDs on disk and removes the spool on close", async () => {
  const f = await fixture([
    userMessage,
    { type: "custom", customType: "zpi.run", data: { phase: "start", runId: "r", queueItemId: "accepted" } },
  ]);
  const session = await readLegacySession(f.path);
  const spool = session.entries.directory;
  try {
    expect(Array.isArray(session.entries)).toBe(false);
    expect(session.entries.length).toBe(2);
    expect(session.entries.at(0)?.id).toBe("e0");
    expect(session.entries.at(-1)?.id).toBe("e1");
    expect(session.acceptedQueueIds).not.toBeInstanceOf(Set);
    expect(session.acceptedQueueIds.has("accepted")).toBe(true);
    expect(session.entries.db.prepare("SELECT COUNT(*) AS n FROM entries").get()?.n).toBe(2);
  } finally {
    session.close();
  }
  await expect(readFile(join(spool, "records.sqlite"))).rejects.toMatchObject({ code: "ENOENT" });
  session.close();
});
