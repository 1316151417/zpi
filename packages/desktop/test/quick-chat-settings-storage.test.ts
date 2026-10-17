import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { StateStore } from "../src/main/state-store.ts";
import { SettingsStore } from "../src/main/storage.ts";
import type { QuickChatSettingsInput } from "../src/shared/bridge.ts";
import { quickChatSelection } from "../src/shared/quick-chat-settings.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of cleanups.splice(0).reverse()) await close();
});
const first = { provider: "first", modelId: "one", reasoning: "none" };
const second = { provider: "second", modelId: "two", reasoning: "medium" };
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "zpi-quick-chat-defaults-"));
  const state = new StateStore(join(dir, "state.sqlite"));
  const encryption = {
    isEncryptionAvailable: () => false,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString(),
  };
  cleanups.push(async () => {
    state.close();
    await rm(dir, { recursive: true, force: true });
  });
  const open = () => new SettingsStore(dir, encryption, state);
  const settings = open();
  settings.saveProvider({
    id: "first",
    name: "First",
    baseUrl: "https://example.com/v1",
    models: [{ id: "one", reasoning: false }],
  });
  settings.saveProvider({
    id: "second",
    name: "Second",
    baseUrl: "https://example.com/v1",
    models: [{ id: "two", reasoning: true, defaultThinkingLevel: "medium" }],
  });
  return { state, open, settings };
}

test("persists independent defaults across restart and never imports or changes lastSelection", async () => {
  const f = await fixture();
  f.settings.rememberSelection(first);
  const input = { defaultSelection: second };
  f.settings.saveQuickChatSettings(input);
  input.defaultSelection = first;
  const restarted = f.open();
  expect(restarted.get().quickChat.defaultSelection).toEqual(second);
  expect(quickChatSelection(restarted.get())).toEqual(second);
  expect(restarted.get().lastSelection).toEqual(first);
  restarted.rememberSelection(second);
  restarted.saveQuickChatSettings({ defaultSelection: null });
  expect(f.open().get().quickChat.defaultSelection).toBeNull();
  expect(quickChatSelection(f.open().get())).toEqual(first);
  expect(f.open().get().lastSelection).toEqual(second);
});

test("migrates older public settings to automatic selection instead of copying the main task model", async () => {
  const f = await fixture();
  f.settings.rememberSelection(second);
  const old = f.state.getSetting<Record<string, unknown>>("app");
  if (!old) throw new Error("Missing settings");
  delete old.quickChat;
  f.state.setSetting("app", old);
  expect(f.open().get().quickChat).toEqual({ defaultSelection: null });
  expect(quickChatSelection(f.open().get())).toEqual(first);
  expect(f.state.getSetting<{ quickChat: QuickChatSettingsInput }>("app")?.quickChat).toEqual({
    defaultSelection: null,
  });
});

test.each([
  null,
  [],
  {},
  { defaultSelection: undefined },
  { defaultSelection: [] },
  { defaultSelection: first, extra: true },
  { defaultSelection: { ...first, extra: true } },
  { defaultSelection: { ...first, modelId: "missing" } },
  { defaultSelection: { ...first, provider: "missing" } },
  { defaultSelection: { ...first, reasoning: "high" } },
  { defaultSelection: { ...second, reasoning: "unsupported" } },
  { defaultSelection: { ...second, provider: 1 } },
])("rejects malformed or unavailable defaults without changing saved settings: %j", async (input) => {
  const f = await fixture();
  f.settings.saveQuickChatSettings({ defaultSelection: second });
  const before = f.settings.get();
  expect(() => f.settings.saveQuickChatSettings(input as QuickChatSettingsInput)).toThrow();
  expect(f.settings.get()).toEqual(before);
  expect(f.open().get().quickChat.defaultSelection).toEqual(second);
});

test.each(["provider-disabled", "provider-removed", "model-disabled", "model-removed", "reasoning-changed"])(
  "falls back from %s to the first enabled model and its own default preset",
  async (change) => {
    const f = await fixture();
    f.settings.saveQuickChatSettings({ defaultSelection: first });
    f.settings.rememberSelection(first);
    const provider = f.settings.snapshot("first");
    if (change === "provider-removed") f.settings.deleteProvider("first");
    else
      f.settings.saveProvider({
        ...provider,
        ...(change === "provider-disabled" ? { enabled: false } : {}),
        models:
          change === "model-removed"
            ? []
            : [
                {
                  id: "one",
                  reasoning: change === "reasoning-changed",
                  compat: { supportsReasoningEffort: false },
                  ...(change === "model-disabled" ? { enabled: false } : {}),
                },
              ],
      });
    expect(quickChatSelection(f.settings.get())).toEqual(second);
    expect(f.settings.get().quickChat.defaultSelection).toEqual(first);
    expect(f.settings.get().lastSelection).toEqual(first);
    expect(() => f.settings.saveQuickChatSettings({ defaultSelection: first })).toThrow();
  },
);

test("provider order determines automatic fallback and no models returns null", async () => {
  const f = await fixture();
  f.settings.reorderProviders(["second", "first"]);
  expect(quickChatSelection(f.settings.get())).toEqual(second);
  f.settings.deleteProvider("second");
  f.settings.deleteProvider("first");
  expect(quickChatSelection(f.settings.get())).toBeNull();
  expect(() => f.settings.saveQuickChatSettings({ defaultSelection: null })).not.toThrow();
});

test("failed writes preserve the prior in-memory and persisted default", async () => {
  const f = await fixture();
  f.settings.saveQuickChatSettings({ defaultSelection: first });
  const before = f.settings.get();
  vi.spyOn(f.state, "setSetting").mockImplementationOnce(() => {
    throw new Error("disk full");
  });
  expect(() => f.settings.saveQuickChatSettings({ defaultSelection: second })).toThrow("disk full");
  expect(f.settings.get()).toEqual(before);
  expect(f.open().get().quickChat.defaultSelection).toEqual(first);
});

test("retains valid default presets even when display choices deduplicate equivalent reasoning mappings", async () => {
  const f = await fixture();
  f.settings.saveProvider({
    ...f.settings.snapshot("first"),
    models: [
      {
        id: "one",
        reasoning: true,
        defaultThinkingLevel: "medium",
        compat: { thinkingFormat: "deepseek", supportsReasoningEffort: false },
      },
    ],
  });
  const selection = { ...first, reasoning: "medium" };
  expect(quickChatSelection(f.settings.get())).toEqual(selection);
  expect(() => f.settings.saveQuickChatSettings({ defaultSelection: selection })).not.toThrow();
  expect(quickChatSelection(f.open().get())).toEqual(selection);
});
