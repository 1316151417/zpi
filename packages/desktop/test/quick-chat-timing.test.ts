import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  maxQuickChatTimingActive,
  maxQuickChatTimingBytes,
  maxQuickChatTimingRecords,
  type QuickChatKind,
  type QuickChatMode,
  type QuickChatOutcome,
  type QuickChatStage,
  QuickChatTiming,
  type QuickChatTimingState,
} from "../src/main/quick-chat-timing.ts";

const directories: string[] = [];
const allStages: QuickChatStage[] = [
  "start",
  "expiry-ready",
  "window-created",
  "window-loaded",
  "window-ready",
  "renderer-ready",
  "geometry",
  "show",
  "native-show",
  "focus",
  "native-focus",
  "settings",
  "renderer-focus",
  "renderer-frame",
  "blur-focused",
  "blur-unfocused",
  "blur-ignored",
  "space-changed",
  "native-hidden",
  "hide-ignored",
  "toggle-hide",
  "ipc-hide",
  "native-close",
  "program-hide",
];
interface SavedRecord {
  id: number;
  kind: QuickChatKind;
  mode: QuickChatMode;
  outcome: QuickChatOutcome;
  stages: { stage: QuickChatStage; ms: number; state?: QuickChatTimingState }[];
}
async function directory() {
  const dir = await fs.mkdtemp(join(tmpdir(), "zpi-quick-chat-timing-"));
  directories.push(dir);
  return dir;
}
function logPath(dir: string) {
  return join(dir, "agent", "logs", "quick-chat-timing.json");
}
async function records(dir: string): Promise<SavedRecord[]> {
  return JSON.parse(await fs.readFile(logPath(dir), "utf8"));
}
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(directories.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

it("does no I/O or clock reads in the constructor, when disabled, or before a trace finishes", async () => {
  const dir = await directory();
  const mkdir = vi.spyOn(fs, "mkdir");
  const chmod = vi.spyOn(fs, "chmod");
  const open = vi.spyOn(fs, "open");
  const readFile = vi.spyOn(fs, "readFile");
  const now = vi.fn(() => 10);
  vi.stubEnv("ZPI_QUICK_CHAT_TIMING", "1");
  for (const timing of [new QuickChatTiming(dir), new QuickChatTiming(dir, false, now)]) {
    expect(timing.start("open", "cold")).toBeUndefined();
    await timing.flush();
  }
  const enabled = new QuickChatTiming(dir, true, now);
  expect(now).not.toHaveBeenCalled();
  const trace = enabled.start("warmup", "cold");
  trace?.mark("window-created");
  await enabled.flush();
  for (const operation of [mkdir, chmod, open, readFile]) expect(operation).not.toHaveBeenCalled();
  trace?.finish("ready");
  for (const operation of [mkdir, chmod, open, readFile]) expect(operation).not.toHaveBeenCalled();
  await enabled.flush();
  expect(open).toHaveBeenCalledOnce();
});

it("records only allowlisted fields and monotonic relative milliseconds in call order", async () => {
  const dir = await directory();
  let now = 100;
  const timing = new QuickChatTiming(dir, true, () => now);
  const trace = timing.start("open", "cold");
  expect(trace?.id).toBe(1);
  expect(Object.isFrozen(trace)).toBe(true);
  now = 104.1254;
  trace?.mark("expiry-ready");
  now = 101;
  trace?.mark("window-created");
  now = Number.NaN;
  trace?.mark("window-loaded");
  now = Number.POSITIVE_INFINITY;
  trace?.mark("window-ready");
  now = 110;
  trace?.mark("show");
  trace?.finish("shown");
  await timing.flush();
  expect(await records(dir)).toEqual([
    {
      id: 1,
      kind: "open",
      mode: "cold",
      outcome: "shown",
      stages: [
        { stage: "start", ms: 0 },
        { stage: "expiry-ready", ms: 4.125 },
        { stage: "window-created", ms: 4.125 },
        { stage: "window-loaded", ms: 4.125 },
        { stage: "window-ready", ms: 4.125 },
        { stage: "show", ms: 10 },
        { stage: "finished", ms: 10 },
      ],
    },
  ]);
});

it("ignores duplicate stages and ends, including marks arriving after finish", async () => {
  const dir = await directory();
  const timing = new QuickChatTiming(dir, true);
  const first = timing.start("warmup", "cold");
  for (let i = 0; i < 100; i++) first?.mark("window-created");
  first?.finish("ready");
  first?.finish("failed");
  first?.mark("renderer-ready");
  const second = timing.start("open", "warm");
  second?.finish("timeout");
  await timing.flush();
  const saved = await records(dir);
  expect(saved.map((record) => [record.id, record.outcome])).toEqual([
    [1, "ready"],
    [2, "timeout"],
  ]);
  expect(saved[0].stages.map((mark) => mark.stage)).toEqual(["start", "window-created", "finished"]);
});

it("automatically timestamps finish once, including timeouts and cancellations", async () => {
  const dir = await directory();
  let now = 100;
  const timing = new QuickChatTiming(dir, true, () => now);
  for (const outcome of ["timeout", "cancelled"] as const) {
    const trace = timing.start("open", "loading");
    now += 10;
    trace?.mark("finished");
    now += 2990;
    trace?.finish(outcome);
    now += 100;
    trace?.finish("shown");
  }
  await timing.flush();
  const saved = await records(dir);
  expect(saved.map((record) => record.outcome)).toEqual(["timeout", "cancelled"]);
  for (const record of saved)
    expect(record.stages).toEqual([
      { stage: "start", ms: 0 },
      { stage: "finished", ms: 3000 },
    ]);
});

it("bounds abandoned active traces and resumes after a slot is released", async () => {
  const dir = await directory();
  const timing = new QuickChatTiming(dir, true);
  const active = Array.from({ length: maxQuickChatTimingActive }, () => timing.start("open", "loading"));
  expect(active.every(Boolean)).toBe(true);
  expect(timing.start("open", "warm")).toBeUndefined();
  active[0]?.finish("cancelled");
  const next = timing.start("open", "warm");
  expect(next?.id).toBe(maxQuickChatTimingActive + 1);
  next?.finish("hidden");
  await timing.flush();
  expect(await records(dir)).toHaveLength(2);
});

it("records hide decisions using fixed stages without a free-form reason", async () => {
  const dir = await directory();
  const timing = new QuickChatTiming(dir, true, () => 0);
  const trace = timing.start("hide", "warm");
  trace?.mark("blur-focused");
  trace?.mark("blur-ignored");
  trace?.mark("hide-ignored");
  trace?.finish("shown");
  await timing.flush();
  expect(await records(dir)).toEqual([
    {
      id: 1,
      kind: "hide",
      mode: "warm",
      outcome: "shown",
      stages: [
        { stage: "start", ms: 0 },
        { stage: "blur-focused", ms: 0 },
        { stage: "blur-ignored", ms: 0 },
        { stage: "hide-ignored", ms: 0 },
        { stage: "finished", ms: 0 },
      ],
    },
  ]);
});

it("retains the latest 64 bounded records in one private file and preserves the error log", async () => {
  const dir = await directory();
  const path = logPath(dir);
  await fs.mkdir(dirname(path), { recursive: true, mode: 0o755 });
  await fs.writeFile(path, "old private text".repeat(maxQuickChatTimingBytes), { mode: 0o644 });
  const errorPath = join(dirname(path), "error.log");
  await fs.writeFile(errorPath, "preserved error record\n");
  let now = 0;
  const timing = new QuickChatTiming(dir, true, () => now++);
  for (let i = 0; i < 1000; i++) {
    const trace = timing.start("open", "warm");
    for (const stage of allStages) trace?.mark(stage);
    trace?.finish("shown");
  }
  await timing.flush();
  const saved = await records(dir);
  expect(saved).toHaveLength(maxQuickChatTimingRecords);
  expect(saved.map((record) => record.id)).toEqual(
    Array.from({ length: maxQuickChatTimingRecords }, (_, index) => 1001 - maxQuickChatTimingRecords + index),
  );
  for (const record of saved) {
    expect(Object.keys(record)).toEqual(["id", "kind", "mode", "outcome", "stages"]);
    expect(record.stages.map((mark) => mark.stage)).toEqual([...allStages, "finished"]);
    for (const mark of record.stages) {
      expect(Object.keys(mark)).toEqual(["stage", "ms"]);
      expect(Number.isFinite(mark.ms)).toBe(true);
      expect(mark.ms).toBeGreaterThanOrEqual(0);
    }
  }
  expect((await fs.stat(path)).size).toBeLessThanOrEqual(maxQuickChatTimingBytes);
  expect(await fs.readdir(dirname(path))).toEqual(["error.log", "quick-chat-timing.json"]);
  expect(await fs.readFile(errorPath, "utf8")).toBe("preserved error record\n");
  if (process.platform !== "win32") {
    expect((await fs.stat(path)).mode & 0o777).toBe(0o600);
    expect((await fs.stat(dirname(path))).mode & 0o777).toBe(0o700);
  }
});

it("rejects private text and object injection at runtime without reading or serializing it", async () => {
  const dir = await directory();
  const timing = new QuickChatTiming(dir, true);
  const secrets = [
    "a private prompt",
    "https://private.example/path",
    "/private/session.json",
    "private-provider",
    "b32a51d5-f1de-41f6-869b-4f84cc3ab336",
  ];
  const stringify = vi.fn(() => secrets.join(" "));
  const hostile = { toString: stringify, toJSON: stringify };
  for (const value of [...secrets, hostile, null, undefined]) {
    expect(timing.start(value as QuickChatKind, "cold")).toBeUndefined();
    expect(timing.start("open", value as QuickChatMode)).toBeUndefined();
  }
  const trace = timing.start("open", "cold");
  for (const value of [...secrets, hostile, null, undefined]) {
    trace?.mark(value as QuickChatStage);
    trace?.finish(value as QuickChatOutcome);
  }
  trace?.mark("renderer-frame");
  trace?.finish("shown");
  await timing.flush();
  const contents = await fs.readFile(logPath(dir), "utf8");
  for (const secret of secrets) expect(contents).not.toContain(secret);
  expect(contents).not.toContain(dir);
  expect(stringify).not.toHaveBeenCalled();
  expect((await records(dir))[0].stages.map((mark) => mark.stage)).toEqual([
    "start",
    "renderer-frame",
    "finished",
  ]);
});

it("copies only the three boolean state fields and never reads private fields or getters", async () => {
  const dir = await directory();
  const timing = new QuickChatTiming(dir, true, () => 0);
  const secret = "private prompt https://private.example /private/file session-uuid provider-name";
  const readSecret = vi.fn(() => secret);
  const state = {
    visible: true,
    focused: false,
    expanded: true,
    prompt: secret,
    toJSON: readSecret,
    get path() {
      return readSecret();
    },
  };
  const trace = timing.start("hide", "warm");
  trace?.mark("blur-unfocused", state);
  state.visible = false;
  state.focused = true;
  state.expanded = false;
  trace?.finish("hidden");

  const invalid = [
    null,
    secret,
    { visible: secret, focused: false, expanded: true },
    { visible: true, focused: false },
    { visible: true, focused: false, expanded: secret },
    Object.create({ visible: true, focused: false, expanded: true }),
    {
      get visible() {
        return readSecret();
      },
      focused: false,
      expanded: true,
    },
    new Proxy(
      {},
      {
        getOwnPropertyDescriptor: () => {
          throw new Error(secret);
        },
      },
    ),
  ];
  for (const value of invalid) {
    const rejected = timing.start("hide", "warm");
    expect(() => rejected?.mark("blur-ignored", value as QuickChatTimingState)).not.toThrow();
    rejected?.finish("shown");
  }
  await timing.flush();
  const saved = await records(dir);
  expect(saved[0].stages[1]).toEqual({
    stage: "blur-unfocused",
    ms: 0,
    state: { visible: true, focused: false, expanded: true },
  });
  for (const record of saved.slice(1)) expect(record.stages[1]).not.toHaveProperty("state");
  expect(readSecret).not.toHaveBeenCalled();
  expect(await fs.readFile(logPath(dir), "utf8")).not.toContain(secret);
});

it("enforces the byte cap even with every boolean snapshot and maximum finite durations", async () => {
  const dir = await directory();
  let now = 0;
  const timing = new QuickChatTiming(dir, true, () => now);
  const state = { visible: true, focused: true, expanded: true };
  for (let i = 0; i < 100; i++) {
    now = 0;
    const trace = timing.start("open", "warm");
    now = Number.MAX_SAFE_INTEGER;
    for (const stage of allStages) trace?.mark(stage, state);
    trace?.finish("shown");
  }
  await timing.flush();
  const saved = await records(dir);
  expect(saved.length).toBeGreaterThan(0);
  expect(saved.length).toBeLessThanOrEqual(maxQuickChatTimingRecords);
  expect(saved.at(-1)?.id).toBe(100);
  expect(saved.map((record) => record.id)).toEqual(
    Array.from({ length: saved.length }, (_, index) => 101 - saved.length + index),
  );
  expect((await fs.stat(logPath(dir))).size).toBeLessThanOrEqual(maxQuickChatTimingBytes);
});

it("swallows I/O failures and retries on a later finish or flush without logging error strings", async () => {
  const dir = await directory();
  const path = logPath(dir);
  await fs.writeFile(join(dir, "agent"), "directory blocker");
  const stderr = vi.spyOn(process.stderr, "write");
  const consoleError = vi.spyOn(console, "error");
  const timing = new QuickChatTiming(dir, true);
  timing.start("open", "cold")?.finish("failed");
  await expect(timing.flush()).resolves.toBeUndefined();
  await fs.rm(join(dir, "agent"));
  await timing.flush();
  expect(await records(dir)).toHaveLength(1);
  const open = vi.spyOn(fs, "open").mockRejectedValueOnce(new Error("secret I/O details"));
  timing.start("open", "loading")?.finish("hidden");
  await timing.flush();
  open.mockRestore();
  timing.start("open", "warm")?.finish("shown");
  await timing.flush();
  expect((await records(dir)).map((record) => record.id)).toEqual([1, 2, 3]);
  expect(await fs.readFile(path, "utf8")).not.toContain("secret I/O details");
  expect(stderr).not.toHaveBeenCalled();
  expect(consoleError).not.toHaveBeenCalled();
});

it("coalesces pending writes and serializes a newer finish after an in-flight write", async () => {
  const dir = await directory();
  const originalOpen = fs.open;
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const open = vi.spyOn(fs, "open").mockImplementationOnce(async (...args) => {
    await gate;
    return originalOpen(...args);
  });
  const timing = new QuickChatTiming(dir, true);
  timing.start("open", "cold")?.finish("shown");
  await vi.waitFor(() => expect(open).toHaveBeenCalledOnce());
  for (let i = 0; i < 100; i++) timing.start("open", "warm")?.finish("shown");
  expect(open).toHaveBeenCalledOnce();
  release();
  await timing.flush();
  expect(open).toHaveBeenCalledTimes(2);
  const saved = await records(dir);
  expect(saved).toHaveLength(maxQuickChatTimingRecords);
  expect(saved[0].id).toBe(38);
  expect(saved.at(-1)?.id).toBe(101);
});

it("never follows a diagnostic symlink or truncates a hard-linked unrelated log", async () => {
  const dir = await directory();
  const path = logPath(dir);
  await fs.mkdir(dirname(path), { recursive: true });
  const target = join(dirname(path), "error.log");
  await fs.writeFile(target, "existing errors");
  const timing = new QuickChatTiming(dir, true);
  await fs.link(target, path);
  timing.start("open", "cold")?.finish("shown");
  await timing.flush();
  expect(await fs.readFile(target, "utf8")).toBe("existing errors");
  await fs.rm(path);
  if (process.platform !== "win32") {
    await fs.symlink(target, path);
    await timing.flush();
    expect(await fs.readFile(target, "utf8")).toBe("existing errors");
    await fs.rm(path);
  }
  await timing.flush();
  expect(await records(dir)).toHaveLength(1);
});

it("keeps throwing or overflowing clocks finite and preserves valid outcomes", async () => {
  const dir = await directory();
  const now = vi.fn((): number => {
    throw new Error("private clock failure");
  });
  const timing = new QuickChatTiming(dir, true, now);
  const trace = timing.start("open", "cold");
  trace?.mark("window-created");
  now.mockImplementation(() => Number.MAX_VALUE);
  trace?.mark("show");
  now.mockImplementation(() => -Number.MAX_VALUE);
  trace?.mark("focus");
  trace?.finish("shown");
  await timing.flush();
  for (const mark of (await records(dir))[0].stages) {
    expect(Number.isFinite(mark.ms)).toBe(true);
    expect(mark.ms).toBeGreaterThanOrEqual(0);
    expect(mark.ms).toBeLessThanOrEqual(Number.MAX_SAFE_INTEGER);
  }
});
