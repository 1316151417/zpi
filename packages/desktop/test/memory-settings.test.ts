import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { StateStore } from "../src/main/state-store.ts";
import { SettingsStore } from "../src/main/storage.ts";
import { defaultMemorySettings, type MemorySettings } from "../src/shared/memory.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of cleanups.splice(0).reverse()) await close();
});
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "zpi-memory-settings-"));
  const state = new StateStore(join(dir, "state.sqlite"));
  const encryption = {
    isEncryptionAvailable: () => false,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString(),
  };
  const open = () => new SettingsStore(dir, encryption, state);
  const settings = open();
  settings.saveProvider({
    id: "provider",
    name: "Provider",
    baseUrl: "https://example.test/v1",
    models: [
      { id: "plain", reasoning: false },
      { id: "thinking", reasoning: true },
    ],
  });
  cleanups.push(async () => {
    state.close();
    await rm(dir, { recursive: true, force: true });
  });
  return { settings, state, open };
}

test("memory defaults are off and do not create data or inherit the conversation model", async () => {
  const { settings, state } = await fixture();
  settings.rememberSelection({ provider: "provider", modelId: "thinking", reasoning: "high" });
  expect(settings.getMemorySettings()).toEqual(defaultMemorySettings);
  expect(state.getSetting("memory.settings")).toBeUndefined();
  const copy = settings.getMemorySettings();
  copy.short = true;
  expect(settings.getMemorySettings().short).toBe(false);
});

test.each([
  [false, false],
  [true, false],
  [false, true],
])("persists exclusive short=%s long=%s across restarts", async (short, long) => {
  const { settings, open } = await fixture();
  const input = { ...defaultMemorySettings, short, long, generate: false };
  settings.saveMemorySettings(input);
  input.short = !short;
  expect(open().getMemorySettings()).toEqual({ ...defaultMemorySettings, short, long, generate: false });
});

test("persists manual and per-stage models without affecting the front-end selection", async () => {
  const { settings, open } = await fixture();
  const plain = { provider: "provider", modelId: "plain", reasoning: "none" };
  const thinking = { provider: "provider", modelId: "thinking", reasoning: "high" };
  settings.rememberSelection(plain);
  const input: MemorySettings = {
    ...defaultMemorySettings,
    modelMode: "manual",
    selection: thinking,
    extractSelection: plain,
    consolidateSelection: thinking,
  };
  settings.saveMemorySettings(input);
  expect(open().getMemorySettings()).toEqual(input);
  expect(open().get().lastSelection).toEqual(plain);
  thinking.reasoning = "low";
  expect(settings.getMemorySettings().selection?.reasoning).toBe("high");
});

test("keeps missing model selection visible for a runtime diagnostic and permits disabling stale settings", async () => {
  const { settings } = await fixture();
  const missing = { provider: "removed", modelId: "missing", reasoning: "high" };
  expect(settings.saveMemorySettings({ ...defaultMemorySettings, selection: missing }).selection).toEqual(
    missing,
  );
  const selection = { provider: "provider", modelId: "thinking", reasoning: "high" };
  settings.saveMemorySettings({ ...defaultMemorySettings, long: true, selection });
  const provider = settings.snapshot("provider");
  settings.saveProvider({
    ...provider,
    models: provider.models.map((model) => ({ ...model, reasoning: false })),
  });
  expect(settings.getMemorySettings().selection).toEqual(selection);
  expect(
    settings.saveMemorySettings({ ...settings.getMemorySettings(), long: false, generate: false }),
  ).toMatchObject({ long: false, generate: false, selection });
});

test.each([
  { ...defaultMemorySettings, short: true, long: true },
  null,
  [],
  {},
  { ...defaultMemorySettings, unknown: true },
  { ...defaultMemorySettings, short: "true" },
  { ...defaultMemorySettings, modelMode: "auto" },
  { ...defaultMemorySettings, selection: undefined },
  { ...defaultMemorySettings, selection: { provider: "provider", modelId: "plain", reasoning: "high" } },
  {
    ...defaultMemorySettings,
    selection: { provider: "provider", modelId: "thinking", reasoning: "unsupported" },
  },
  {
    ...defaultMemorySettings,
    extractSelection: { provider: "provider", modelId: "thinking", reasoning: "high", extra: true },
  },
  {
    ...defaultMemorySettings,
    consolidateSelection: { provider: "", modelId: "thinking", reasoning: "high" },
  },
  { ...defaultMemorySettings, minIdleHours: 0 },
  { ...defaultMemorySettings, maxAgeDays: 1.5 },
  { ...defaultMemorySettings, maxRolloutsPerBatch: 17 },
])("rejects invalid settings without changing persisted state: %j", async (input) => {
  const { settings } = await fixture();
  settings.saveMemorySettings({ ...defaultMemorySettings, short: true });
  expect(() => settings.saveMemorySettings(input as MemorySettings)).toThrow();
  expect(settings.getMemorySettings()).toEqual({ ...defaultMemorySettings, short: true });
});

test("failed durable writes leave the previous setting available", async () => {
  const { settings, state, open } = await fixture();
  settings.saveMemorySettings({ ...defaultMemorySettings, short: true });
  vi.spyOn(state, "setSetting").mockImplementationOnce(() => {
    throw new Error("disk full");
  });
  expect(() => settings.saveMemorySettings({ ...defaultMemorySettings, long: true })).toThrow("disk full");
  expect(open().getMemorySettings()).toEqual({ ...defaultMemorySettings, short: true });
});

test("legacy dual-enabled settings migrate to long memory without changing model or thresholds", async () => {
  const { settings, state, open } = await fixture();
  state.setSetting("memory.settings", { ...defaultMemorySettings, short: true, long: true, maxAgeDays: 90 });
  const expected = { ...defaultMemorySettings, short: false, long: true, maxAgeDays: 90 };
  expect(settings.getMemorySettings()).toEqual(expected);
  expect(state.getSetting("memory.settings")).toEqual(expected);
  expect(open().getMemorySettings()).toEqual(expected);
});
