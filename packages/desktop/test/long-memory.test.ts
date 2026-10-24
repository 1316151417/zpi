import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import {
  LongMemoryService,
  type LongMemorySource,
  type LongMemoryState,
  type MemoryRunRequest,
  type MemoryRunResult,
} from "../src/main/memory/long-memory.ts";
import type { CombinedSelection } from "../src/shared/bridge.ts";
import { defaultMemorySettings, type MemorySettings } from "../src/shared/memory.ts";

const directories: string[] = [];
const services: LongMemoryService[] = [];
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const model: CombinedSelection = { provider: "fake", modelId: "memory", reasoning: "medium" };
const enabled: MemorySettings = { ...defaultMemorySettings, long: true };

afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.close()));
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "zpi-long-memory-"));
  directories.push(directory);
  let now = Date.UTC(2026, 9, 23, 10);
  let state: LongMemoryState | undefined;
  let failPublication = false;
  let sources: LongMemorySource[] = [];
  const requests: MemoryRunRequest[] = [];
  const run = vi.fn(async (request: MemoryRunRequest): Promise<MemoryRunResult> => {
    requests.push(request);
    return {
      text: JSON.stringify(
        request.stage === "extract"
          ? {
              rawMemory: "Project-only constraint: preserve existing API.",
              rolloutSummary: "User asked to preserve API; verified tests passed.",
            }
          : {
              memory: "# Project experience\nScope: /workspace/a\nPreserve existing API.",
              summary: "## Memory index\nProject a: preserve existing API.",
            },
      ),
      usage: { tokens: 10, cost: 0.001 },
    };
  });
  const service = new LongMemoryService({
    directory,
    getState: () => state,
    setState: (next) => {
      if (failPublication && next.activeGeneration !== state?.activeGeneration)
        throw new Error("storage: publication unavailable");
      state = next;
    },
    sources: async () => sources,
    run,
    now: () => now,
  });
  services.push(service);
  const source = (id = "session-a", changes: Partial<LongMemorySource> = {}): LongMemorySource => ({
    id,
    cwd: "/workspace/a",
    title: `Task ${id}`,
    createdAt: now - 2 * DAY,
    updatedAt: now - 7 * HOUR,
    boundary: "1:10",
    evidencePath: join(directory, "history", `${id}.md`),
    read: async () =>
      "[human user] Please preserve the API.\n[tool] Tests passed.\n[assistant proposal] Try another framework.",
    ...changes,
  });
  return {
    service,
    directory,
    run,
    requests,
    source,
    get state() {
      if (!state) throw new Error("Expected persisted memory state");
      return state;
    },
    set state(value) {
      state = value;
    },
    get now() {
      return now;
    },
    set now(value) {
      now = value;
    },
    get sources() {
      return sources;
    },
    set sources(value) {
      sources = value;
    },
    set failPublication(value: boolean) {
      failPublication = value;
    },
  };
}

test.each([
  { short: false, long: false, calls: 0 },
  { short: true, long: false, calls: 0 },
  { short: false, long: true, calls: 2 },
  { short: true, long: true, calls: 2 },
])("independent switches: short=$short long=$long", async ({ short, long, calls }) => {
  const f = await fixture();
  f.sources = [f.source()];
  await f.service.check(model, { ...enabled, short, long });
  expect(f.run).toHaveBeenCalledTimes(calls);
  expect(f.service.status().sources.length > 0).toBe(long);
});

test("eligibility uses idle age, ignores active sources, and bounds one batch", async () => {
  const f = await fixture();
  f.sources = [
    f.source("fresh", { updatedAt: f.now - HOUR }),
    f.source("old", { updatedAt: f.now - 11 * DAY }),
    f.source("active", { active: true }),
    f.source("a"),
    f.source("b"),
    f.source("c"),
  ];
  await f.service.check(model, enabled);
  expect(f.requests.filter(({ stage }) => stage === "extract")).toHaveLength(2);
  expect(Object.keys(f.state.jobs)).toEqual(["a", "b"]);
  expect(f.state.records.active).toBeUndefined();
});

test("reports no candidates separately from not yet idle", async () => {
  const f = await fixture();
  await f.service.check(model, enabled);
  expect(f.service.status().status).toBe("no-candidates");
  f.sources = [f.source("fresh", { updatedAt: f.now - HOUR })];
  await f.service.check(model, enabled);
  expect(f.service.status().status).toBe("waiting-idle");
  expect(f.run).not.toHaveBeenCalled();
});

test("two phases publish source-linked files, inject only summary, and skip unchanged inputs", async () => {
  const f = await fixture();
  f.sources = [f.source()];
  await f.service.check(model, enabled);
  expect(f.requests.map(({ stage }) => stage)).toEqual(["extract", "consolidate"]);
  const status = f.service.status();
  expect(status.tokens).toBe(20);
  expect(status.cost).toBe(0.002);
  expect((await readdir(status.path)).sort()).toEqual([
    "MEMORY.md",
    "memory_summary.md",
    "raw_memories.md",
    "rollout_summaries",
  ]);
  const recap = await readFile(status.sources[0].summaryPath ?? "", "utf8");
  expect(recap).toContain('session_id: "session-a"');
  expect(recap).toContain('source_boundary: "1:10"');
  expect(recap).toContain('workspace: "/workspace/a"');
  expect(recap).toContain("evidence_path:");
  const context = await f.service.context();
  expect(context.instructions.join("\n")).toContain("Project a: preserve existing API.");
  expect(context.instructions.join("\n")).not.toContain("User asked to preserve API; verified tests passed.");
  expect(context.sources).toHaveLength(1);
  await f.service.check(model, enabled);
  expect(f.run).toHaveBeenCalledTimes(2);
  expect(f.service.status().status).toBe("unchanged");
});

test("empty extraction persists the boundary and does not repeatedly invoke either model", async () => {
  const f = await fixture();
  f.sources = [f.source()];
  f.run.mockResolvedValue({ text: '{"rawMemory":"","rolloutSummary":""}' });
  await f.service.check(model, enabled);
  await f.service.check(model, enabled);
  expect(f.run).toHaveBeenCalledTimes(1);
  expect(f.state.jobs["session-a"].completed).toBe(true);
  expect(f.state.activeGeneration).toBeUndefined();
});

test("failed extraction backs off, caps retries, and retries a changed source boundary", async () => {
  const f = await fixture();
  f.sources = [f.source()];
  f.run.mockRejectedValue(
    Object.assign(new Error("Invalid model credentials"), { usage: { tokens: 7, cost: null } }),
  );
  await f.service.check(model, enabled);
  await f.service.check(model, enabled);
  expect(f.run).toHaveBeenCalledTimes(1);
  expect(f.service.status().message).toContain("Invalid model credentials");
  f.now += HOUR;
  await f.service.check(model, enabled);
  f.now += HOUR;
  await f.service.check(model, enabled);
  f.now += HOUR;
  await f.service.check(model, enabled);
  expect(f.run).toHaveBeenCalledTimes(3);
  expect(f.state.jobs["session-a"].completed).toBe(false);
  expect(f.service.status().tokens).toBe(21);
  expect(f.service.status().cost).toBeNull();
  f.sources[0].boundary = "1:20";
  await f.service.check(model, enabled);
  expect(f.run).toHaveBeenCalledTimes(4);
  expect(f.state.jobs["session-a"].attempts).toBe(1);
});

test("concurrent checks deduplicate and freeze triggering model and reasoning for both stages", async () => {
  const f = await fixture();
  f.sources = [f.source()];
  let release!: (value: MemoryRunResult) => void;
  const gate = new Promise<MemoryRunResult>((resolve) => {
    release = resolve;
  });
  f.run.mockImplementationOnce(async (request) => {
    f.requests.push(request);
    return gate;
  });
  const trigger = { ...model };
  const first = f.service.check(trigger, enabled);
  expect(f.service.check({ ...model, modelId: "other" }, enabled)).toBe(first);
  trigger.modelId = "changed-later";
  trigger.reasoning = "low";
  await vi.waitFor(() => expect(f.run).toHaveBeenCalledTimes(1));
  release({ text: '{"rawMemory":"remember","rolloutSummary":"evidence"}' });
  await first;
  expect(f.requests.map(({ model: selection }) => selection)).toEqual([model, model]);
});

test("manual model and stage overrides are explicit; missing manual selection fails visibly", async () => {
  const f = await fixture();
  f.sources = [f.source()];
  await f.service.check(model, { ...enabled, modelMode: "manual" });
  expect(f.service.status().status).toBe("failed");
  expect(f.run).not.toHaveBeenCalled();
  const manual = { provider: "custom", modelId: "base", reasoning: "high" };
  const extraction = { provider: "custom", modelId: "cheap", reasoning: "low" };
  const consolidation = { provider: "custom", modelId: "strong", reasoning: "max" };
  await f.service.check(model, {
    ...enabled,
    modelMode: "manual",
    selection: manual,
    extractSelection: extraction,
    consolidateSelection: consolidation,
  });
  expect(f.requests.map(({ model: selection }) => selection)).toEqual([extraction, consolidation]);
});

test.each(["not JSON", '{"memory":"ok","summary":"ok","skills":"bad"}', '{"memory":"ok","summary":""}'])(
  "invalid consolidation preserves previous publication: %s",
  async (badOutput) => {
    const f = await fixture();
    f.sources = [f.source()];
    await f.service.check(model, enabled);
    const previous = f.state.activeGeneration;
    const previousSummary = (await f.service.context()).instructions;
    f.sources[0].boundary = "1:20";
    f.run.mockImplementation(async (request) => ({
      text: request.stage === "extract" ? '{"rawMemory":"new","rolloutSummary":"new evidence"}' : badOutput,
    }));
    await f.service.check(model, enabled);
    expect(f.state.activeGeneration).toBe(previous);
    expect((await f.service.context()).instructions).toEqual(previousSummary);
    expect(f.service.status().status).toBe("failed");
  },
);

test("pause and disable abort a running task even if runner resolves late; pause retains reading", async () => {
  const f = await fixture();
  f.sources = [f.source()];
  await f.service.check(model, enabled);
  const previous = f.state.activeGeneration;
  f.sources[0].boundary = "1:20";
  let release!: (value: MemoryRunResult) => void;
  f.run.mockImplementationOnce(
    async () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const task = f.service.check(model, enabled);
  await vi.waitFor(() => expect(release).toBeTypeOf("function"));
  f.service.configure({ ...enabled, generate: false });
  await task;
  release({ text: '{"rawMemory":"late","rolloutSummary":"late"}' });
  expect(f.state.activeGeneration).toBe(previous);
  expect(f.service.status().status).toBe("paused");
  expect((await f.service.context()).sources).toHaveLength(1);
  f.service.configure({ ...enabled, long: false });
  expect((await f.service.context()).sources).toHaveLength(1);
});

test("clear cancels pending tasks, clears artifacts and notes, and tombstones existing source versions", async () => {
  const f = await fixture();
  f.sources = [f.source()];
  await f.service.check(model, enabled);
  await writeFile(join(f.directory, "memory_notes.md"), "Forget the API preference.");
  f.sources[0].boundary = "1:20";
  let release!: (value: MemoryRunResult) => void;
  f.run.mockImplementationOnce(
    async () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const task = f.service.check(model, enabled);
  await vi.waitFor(() => expect(release).toBeTypeOf("function"));
  await f.service.clear();
  await task;
  release({ text: '{"rawMemory":"late","rolloutSummary":"late"}' });
  expect(f.state.activeGeneration).toBeUndefined();
  expect(f.state.tombstones["session-a"]).toBe("1:20");
  await expect(readdir(f.directory)).rejects.toMatchObject({ code: "ENOENT" });
  const calls = f.run.mock.calls.length;
  await f.service.check(model, enabled);
  expect(f.run).toHaveBeenCalledTimes(calls);
  f.sources[0].boundary = "1:21";
  await f.service.check(model, enabled);
  expect(f.run).toHaveBeenCalledTimes(calls + 2);
});

test("deleted source is removed from reconstruction and stale summary stays hidden until consolidation", async () => {
  const f = await fixture();
  f.sources = [f.source()];
  await f.service.check(model, enabled);
  const previous = f.state.activeGeneration;
  await f.service.invalidateSource("session-a");
  expect((await f.service.context()).sources).toEqual([]);
  expect((await f.service.context()).instructions.join("\n")).not.toContain(
    "Project a: preserve existing API.",
  );
  expect(f.state.activeGeneration).toBe(previous);
  f.sources = [];
  await f.service.check(model, enabled);
  const prompt = f.requests.at(-1)?.prompt;
  expect(prompt).toContain('"removed":["rollout_summaries/');
  expect(f.state.activeSources).toEqual([]);
  expect(await readdir(join(f.service.status().path, "rollout_summaries"))).toEqual([]);
});

test("persistent forget notes change the fingerprint and remain an input after another source update", async () => {
  const f = await fixture();
  f.sources = [f.source()];
  await f.service.check(model, enabled);
  const note = "2026-10-23: Forget the API preference for /workspace/a.";
  await writeFile(join(f.directory, "memory_notes.md"), note);
  await f.service.check(model, enabled);
  expect(f.requests.at(-1)?.stage).toBe("consolidate");
  expect(f.requests.at(-1)?.prompt).toContain(note);
  f.sources[0].boundary = "1:20";
  await f.service.check(model, enabled);
  expect(f.requests.at(-1)?.prompt).toContain(note);
  expect(await readFile(join(f.directory, "memory_notes.md"), "utf8")).toBe(note);
});

test("retention propagates removal but keeps success boundary to avoid regenerating old evidence", async () => {
  const f = await fixture();
  f.sources = [f.source()];
  await f.service.check(model, enabled);
  f.now += 31 * DAY;
  await f.service.check(model, { ...enabled, maxAgeDays: 90 });
  expect(f.requests.filter(({ stage }) => stage === "extract")).toHaveLength(1);
  expect(f.state.records["session-a"]).toBeUndefined();
  expect(f.state.jobs["session-a"].completed).toBe(true);
  expect(f.state.activeSources).toEqual([]);
});

test("actual source use extends retention without forcing consolidation for rank-only changes", async () => {
  const f = await fixture();
  f.sources = [f.source()];
  await f.service.check(model, enabled);
  f.now += 29 * DAY;
  f.service.recordUsage(["session-a", "session-a"]);
  f.now += 2 * DAY;
  await f.service.check(model, { ...enabled, maxAgeDays: 90 });
  expect(f.state.records["session-a"].usageCount).toBe(1);
  expect(f.state.activeSources).toHaveLength(1);
  expect(f.run).toHaveBeenCalledTimes(2);
});

test("evidence provenance instructions and secret redaction apply before upload and storage", async () => {
  const f = await fixture();
  f.sources = [
    f.source("secret", { read: async () => "[human user] Please remember my api_key=sk-1234567890123456" }),
  ];
  f.run.mockImplementation(async (request) => {
    f.requests.push(request);
    return {
      text: JSON.stringify(
        request.stage === "extract"
          ? {
              rawMemory: "api_key=sk-1234567890123456",
              rolloutSummary: "User proposed a key sk-1234567890123456",
            }
          : { memory: "# Memory", summary: "## Memory index" },
      ),
    };
  });
  await f.service.check(model, enabled);
  expect(f.requests[0].prompt).not.toContain("sk-1234567890123456");
  expect(f.requests[0].prompt).toContain("injected memories");
  expect(f.requests[0].prompt).toContain("not new evidence");
  expect(JSON.stringify(f.state)).not.toContain("sk-1234567890123456");
});

test("close cancels background work and prevents new requests", async () => {
  const f = await fixture();
  f.sources = [f.source()];
  f.run.mockImplementationOnce(async () => new Promise(() => {}));
  const task = f.service.check(model, enabled);
  await vi.waitFor(() => expect(f.run).toHaveBeenCalledTimes(1));
  await f.service.close();
  await task;
  await f.service.check(model, enabled);
  expect(f.run).toHaveBeenCalledTimes(1);
  expect(f.state.activeGeneration).toBeUndefined();
});

test("a context lease keeps the exact generation readable until that foreground turn releases it", async () => {
  const f = await fixture();
  f.sources = [f.source()];
  await f.service.check(model, enabled);
  const oldPath = f.service.status().path;
  const context = await f.service.context();
  f.sources[0].boundary = "1:20";
  await f.service.check(model, enabled);
  expect(f.service.status().path).not.toBe(oldPath);
  expect(await readFile(context.sources[0].summaryPath ?? "", "utf8")).toContain("1:10");
  context.release();
  context.release();
  await vi.waitFor(async () => {
    await expect(readdir(oldPath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

test("active history keeps its existing memory and deleting an unrelated task does not invalidate it", async () => {
  const f = await fixture();
  f.sources = [f.source()];
  await f.service.check(model, enabled);
  f.sources[0].active = true;
  f.sources[0].boundary = "1:20";
  await f.service.check(model, enabled);
  await f.service.invalidateSource("unrelated-subagent");
  expect(f.state.invalidated).toBe(false);
  expect(f.state.activeSources).toHaveLength(1);
  expect(f.run).toHaveBeenCalledTimes(2);
});

test("a consolidation referencing a deleted source is rejected, keeping old artifacts but hiding stale context", async () => {
  const f = await fixture();
  f.sources = [f.source()];
  await f.service.check(model, enabled);
  const original = f.state.activeGeneration;
  await f.service.invalidateSource("session-a");
  f.sources = [];
  f.run.mockResolvedValue({ text: '{"memory":"See rollout_summaries/deleted.md","summary":"stale"}' });
  await f.service.check(model, enabled);
  expect(f.service.status().status).toBe("failed");
  expect(f.service.status().message).toContain("已删除的来源");
  expect(f.state.activeGeneration).toBe(original);
  expect((await f.service.context()).sources).toEqual([]);
});

test("empty regenerated extraction removes a previously retained source from consolidation", async () => {
  const f = await fixture();
  f.sources = [f.source()];
  await f.service.check(model, enabled);
  f.sources[0].boundary = "1:20";
  f.run.mockResolvedValueOnce({ text: '{"rawMemory":"","rolloutSummary":""}' });
  await f.service.check(model, enabled);
  expect(f.state.records["session-a"]).toBeUndefined();
  expect(f.state.activeSources).toEqual([]);
  expect(f.requests.at(-1)?.prompt).toContain('"removed":["rollout_summaries/');
});

test.each([
  { rawMemory: "partial raw", rolloutSummary: "" },
  { rawMemory: "", rolloutSummary: "partial summary" },
])("half-empty extraction is failure and preserves previous valid record: %j", async (partial) => {
  const f = await fixture();
  f.sources = [f.source()];
  await f.service.check(model, enabled);
  const original = structuredClone(f.state.records["session-a"]);
  const generation = f.state.activeGeneration;
  f.sources[0].boundary = "1:20";
  f.run.mockResolvedValueOnce({ text: JSON.stringify(partial) });
  await f.service.check(model, enabled);
  expect(f.service.status().status).toBe("failed");
  expect(f.service.status().message).toContain("提取产物不完整");
  expect(f.state.records["session-a"]).toEqual(original);
  expect(f.state.activeGeneration).toBe(generation);
  expect(f.state.jobs["session-a"].completed).toBe(false);
});

test("clear supplies a durable evidence cutoff and empty post-clear history requires no model call", async () => {
  const f = await fixture();
  const read = vi.fn(async (_afterBoundary?: string) => "");
  f.sources = [f.source("session-a", { read })];
  await f.service.clear();
  f.sources[0].boundary = "2:1";
  await f.service.check(model, enabled);
  expect(read).toHaveBeenCalledWith("1:10");
  expect(f.run).not.toHaveBeenCalled();
  expect(f.state.jobs["session-a"].completed).toBe(true);
  expect(f.state.activeGeneration).toBeUndefined();
});

test("an empty rewritten generation rebases the clear cutoff so later appended evidence is eligible", async () => {
  const f = await fixture();
  const read = vi.fn(async (_afterBoundary?: string) => "");
  f.sources = [f.source("session-a", { read })];
  await f.service.clear();
  f.sources[0].boundary = "new:generation:3";
  await f.service.check(model, enabled);
  expect(read).toHaveBeenLastCalledWith("1:10");
  expect(f.state.tombstones["session-a"]).toBe("new:generation:3");
  expect(f.state.jobs["session-a"].completed).toBe(true);
  expect(f.run).not.toHaveBeenCalled();
  f.sources[0].boundary = "new:generation:4";
  read.mockResolvedValueOnce("[human user] A new explicitly reusable preference.");
  await f.service.check(model, enabled);
  expect(read).toHaveBeenLastCalledWith("new:generation:3");
  expect(f.run).toHaveBeenCalledTimes(2);
  expect(f.state.records["session-a"].boundary).toBe("new:generation:4");
});

test("cancelled calls can settle usage separately without publishing their late result", async () => {
  const f = await fixture();
  f.sources = [f.source()];
  let release!: (value: MemoryRunResult) => void;
  f.run.mockImplementationOnce(
    async () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const work = f.service.check(model, enabled);
  await vi.waitFor(() => expect(release).toBeTypeOf("function"));
  await f.service.stop();
  release({ text: '{"rawMemory":"late","rolloutSummary":"late"}', usage: { tokens: 42, cost: null } });
  await work;
  await vi.waitFor(() => expect(f.service.status().tokens).toBe(42));
  expect(f.state.activeGeneration).toBeUndefined();
  expect(f.run).toHaveBeenCalledTimes(1);
});

test("a failed publication keeps the previous durable pointer and cleans the unpublished generation", async () => {
  const f = await fixture();
  f.sources = [f.source()];
  await f.service.check(model, enabled);
  const generation = f.state.activeGeneration;
  f.sources[0].boundary = "1:20";
  f.failPublication = true;
  await f.service.check(model, enabled);
  expect(f.service.status().status).toBe("failed");
  expect(f.state.activeGeneration).toBe(generation);
  expect(await readdir(join(f.directory, "generations"))).toEqual([generation]);
  expect(await readFile(join(f.service.status().path, "memory_summary.md"), "utf8")).toContain(
    "Memory index",
  );
});

test("startup removes abandoned temporary output and drain waits for cancelled transport settlement", async () => {
  const f = await fixture();
  const pending = join(f.directory, "generations", ".pending-00000000-0000-0000-0000-000000000000");
  await mkdir(pending, { recursive: true });
  await writeFile(join(pending, "MEMORY.md"), "abandoned");
  f.sources = [f.source()];
  let release!: (value: MemoryRunResult) => void;
  f.run.mockImplementationOnce(
    async () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const task = f.service.check(model, enabled);
  await vi.waitFor(() => expect(release).toBeTypeOf("function"));
  await expect(readdir(pending)).rejects.toMatchObject({ code: "ENOENT" });
  await f.service.close();
  await task;
  let drained = false;
  const drain = f.service.drain().then(() => {
    drained = true;
  });
  await Promise.resolve();
  expect(drained).toBe(false);
  release({ text: '{"rawMemory":"late","rolloutSummary":"late"}' });
  await drain;
  expect(drained).toBe(true);
  expect(f.state.activeGeneration).toBeUndefined();
});

test("invalidating a no-output job leaves unrelated published memory visible", async () => {
  const f = await fixture();
  f.sources = [f.source("published"), f.source("empty", { read: async () => "" })];
  await f.service.check(model, enabled);
  expect(f.state.jobs.empty.completed).toBe(true);
  expect(f.state.records.empty).toBeUndefined();
  await f.service.invalidateSource("empty");
  f.sources = f.sources.filter(({ id }) => id !== "empty");
  expect(f.state.invalidated).toBe(false);
  expect((await f.service.context()).sources.map(({ sessionId }) => sessionId)).toEqual(["published"]);
  await f.service.check(model, enabled);
  expect(f.service.status().status).toBe("unchanged");
  expect(f.run).toHaveBeenCalledTimes(2);
});

test("identical valid published inputs clear a stale invalidation without another model call", async () => {
  const f = await fixture();
  f.sources = [f.source()];
  await f.service.check(model, enabled);
  f.state = { ...f.state, invalidated: true };
  await f.service.check(model, enabled);
  expect(f.state.invalidated).toBe(false);
  expect((await f.service.context()).sources).toHaveLength(1);
  expect(f.run).toHaveBeenCalledTimes(2);
});

test("archived sources are ineligible but clear also tombstones them before later restoration", async () => {
  const f = await fixture();
  const read = vi.fn(async (_afterBoundary?: string) => "[human user] Newly appended evidence.");
  f.sources = [f.source("archived", { eligible: false, read })];
  await f.service.check(model, enabled);
  expect(f.run).not.toHaveBeenCalled();
  expect(read).not.toHaveBeenCalled();
  await f.service.clear();
  expect(f.state.tombstones.archived).toBe("1:10");
  f.sources[0].eligible = true;
  await f.service.check(model, enabled);
  expect(f.run).not.toHaveBeenCalled();
  f.sources[0].boundary = "1:11";
  await f.service.check(model, enabled);
  expect(read).toHaveBeenLastCalledWith("1:10");
  expect(f.run).toHaveBeenCalledTimes(2);
});

test("archiving a previously published source removes it from the next consolidation", async () => {
  const f = await fixture();
  f.sources = [f.source()];
  await f.service.check(model, enabled);
  f.sources[0].eligible = false;
  await f.service.check(model, enabled);
  expect(f.requests.filter(({ stage }) => stage === "extract")).toHaveLength(1);
  expect(f.state.activeSources).toEqual([]);
  expect(f.requests.at(-1)?.prompt).toContain('"removed":["rollout_summaries/');
});

test("normal transcript rewrite invalidation permits full extraction without creating a clear cutoff", async () => {
  const f = await fixture();
  const read = vi.fn(async (_afterBoundary?: string) => "[human user] Source evidence.");
  f.sources = [f.source("rewritten", { read })];
  await f.service.check(model, enabled);
  await f.service.invalidateSource("rewritten");
  f.sources[0].boundary = "2:10";
  await f.service.check(model, enabled);
  expect(read).toHaveBeenLastCalledWith(undefined);
  expect(f.state.tombstones.rewritten).toBeUndefined();
  expect(f.state.records.rewritten.boundary).toBe("2:10");
  expect(f.run).toHaveBeenCalledTimes(4);
});

test("slow extraction failures back off from the failure time", async () => {
  const f = await fixture();
  f.sources = [f.source()];
  f.run.mockImplementationOnce(async () => {
    f.now += 2 * HOUR;
    throw new Error("slow extraction failed");
  });
  await f.service.check(model, enabled);
  expect(f.state.jobs["session-a"].retryAt).toBe(f.now + HOUR);
  await f.service.check(model, enabled);
  expect(f.run).toHaveBeenCalledTimes(1);
  f.now += HOUR;
  await f.service.check(model, enabled);
  expect(f.service.status().status).toBe("success");
});

test("slow consolidation failures back off from the failure time", async () => {
  const f = await fixture();
  f.sources = [f.source()];
  const normal = f.run.getMockImplementation();
  f.run.mockImplementation(async (request) => {
    if (request.stage === "consolidate") {
      f.now += 2 * HOUR;
      throw new Error("slow consolidation failed");
    }
    if (!normal) throw new Error("missing model fixture");
    return normal(request);
  });
  await f.service.check(model, enabled);
  expect(f.state.consolidationRetryAt).toBe(f.now + HOUR);
  await f.service.check(model, enabled);
  expect(f.run).toHaveBeenCalledTimes(2);
});

test("cancelling extraction repeatedly does not exhaust the failure budget", async () => {
  const f = await fixture();
  f.sources = [f.source()];
  const normal = f.run.getMockImplementation();
  f.run.mockImplementation(
    async (request) =>
      new Promise((_, reject) => {
        request.signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
      }),
  );
  for (let attempt = 1; attempt <= 3; attempt++) {
    const work = f.service.check(model, enabled);
    await vi.waitFor(() => expect(f.run).toHaveBeenCalledTimes(attempt));
    await f.service.stop();
    await work;
    expect(f.state.jobs["session-a"].attempts).toBe(0);
  }
  if (!normal) throw new Error("missing model fixture");
  f.run.mockImplementation(normal);
  await f.service.check(model, enabled);
  expect(f.service.status().status).toBe("success");
});

test("unchanged inputs restore missing generated source files without another model call", async () => {
  const f = await fixture();
  f.sources = [f.source()];
  await f.service.check(model, enabled);
  const previous = f.service.status();
  await rm(join(previous.path, "raw_memories.md"));
  await rm(previous.sources[0].summaryPath as string);
  await f.service.check(model, enabled);
  expect(f.run).toHaveBeenCalledTimes(2);
  const current = f.service.status();
  expect(current.path).not.toBe(previous.path);
  expect(await readFile(join(current.path, "raw_memories.md"), "utf8")).toContain("session-a");
  expect(await readFile(current.sources[0].summaryPath as string, "utf8")).toContain("session-a");
});

test("an existing library distinguishes newly waiting history from unchanged evidence", async () => {
  const f = await fixture();
  f.sources = [f.source()];
  await f.service.check(model, enabled);
  f.sources.push(f.source("fresh", { updatedAt: f.now - HOUR }));
  await f.service.check(model, enabled);
  expect(f.service.status().status).toBe("waiting-idle");
  expect(f.service.status().sources).toHaveLength(1);
  expect(f.run).toHaveBeenCalledTimes(2);
});
