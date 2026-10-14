import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { ChatGPTCredential } from "zpi-ai/auth/openai-chatgpt";
import { deferred } from "../../../tests/fake-server.ts";
import { ChatGPTAuth } from "../src/main/chatgpt-auth.ts";
import { SettingsStore } from "../src/main/storage.ts";

const login = vi.hoisted(() => ({ wait: vi.fn(), cancel: vi.fn() }));
vi.mock("zpi-ai/auth/openai-chatgpt", async (original) => ({
  ...(await original<typeof import("zpi-ai/auth/openai-chatgpt")>()),
  beginChatGPTLogin: async () => ({ ...login, url: "https://example.invalid/login" }),
}));
const codec = {
  isEncryptionAvailable: () => true,
  encryptString: (value: string) => Buffer.from(value),
  decryptString: (value: Buffer) => value.toString(),
};
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  vi.clearAllMocks();
});
const credential = (suffix: string): ChatGPTCredential => ({
  access: `synthetic-access-${suffix}`,
  refresh: `synthetic-refresh-${suffix}`,
  expires: Date.now() + 3600000,
  clientId: "oaiapp_test",
  subject: "test-user",
  idToken: `synthetic-id-${suffix}`,
  scopes: ["chatgpt.tokens.use.direct"],
});

it.each([
  [false, false],
  [false, true],
  [true, false],
  [true, true],
])("cancelled model discovery cannot commit login (returning=%s, failure=%s)", async (returning, failure) => {
  const dir = await mkdtemp(join(tmpdir(), "zpi-auth-cancel-"));
  directories.push(dir);
  const settings = new SettingsStore(dir, codec);
  if (returning) {
    settings.saveProvider({
      id: "chatgpt",
      preset: "openai-chatgpt",
      name: "ChatGPT",
      baseUrl: "https://api.openai.com/v1",
      models: [{ id: "original", reasoning: false }],
    });
    settings.saveChatGPTCredential("chatgpt", credential("old"));
  }
  const previous = returning ? await readFile(join(dir, "credentials.enc")) : undefined;
  const entered = deferred<void>();
  const response = deferred<Response>();
  login.wait.mockResolvedValue(credential("new"));
  const auth = new ChatGPTAuth(settings, async () => {
    entered.resolve();
    return response.promise;
  });
  const attempt = await auth.begin(returning ? "chatgpt" : null);
  const completing = auth.complete(attempt.loginId);
  await entered.promise;
  auth.cancel(attempt.loginId);
  const rejection = expect(completing).rejects.toThrow("登录已取消");
  response.resolve(
    failure
      ? new Response(null, { status: 500 })
      : Response.json({ models: [{ slug: "new-model", visibility: "list" }] }),
  );
  await rejection;
  const reopened = new SettingsStore(dir, codec);
  if (returning) {
    expect(reopened.getChatGPTCredential("chatgpt")).toMatchObject({
      access: "synthetic-access-old",
      refresh: "synthetic-refresh-old",
    });
    expect(await readFile(join(dir, "credentials.enc"))).toEqual(previous);
    expect(reopened.get().providers[0].models[0].id).toBe("original");
  } else expect(reopened.get().providers).toEqual([]);
  auth.close();
});

it("still commits a completed login when optional model discovery fails", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zpi-auth-discovery-failed-"));
  directories.push(dir);
  const settings = new SettingsStore(dir, codec);
  login.wait.mockResolvedValue(credential("new"));
  const auth = new ChatGPTAuth(settings, async () => new Response(null, { status: 500 }));
  const attempt = await auth.begin(null);
  const result = await auth.complete(attempt.loginId);
  expect(result.warning).toContain("模型列表获取失败");
  expect(new SettingsStore(dir, codec).get().providers[0].chatgptAccount?.connected).toBe(true);
  auth.close();
});

it.each([false, true])(
  "failed credential persistence leaves no partial login, including on retry (returning=%s)",
  async (returning) => {
    const dir = await mkdtemp(join(tmpdir(), "zpi-auth-persist-failed-"));
    directories.push(dir);
    let fail = false;
    const settings = new SettingsStore(dir, {
      ...codec,
      encryptString: (value) => {
        if (fail && value.includes("synthetic-access-new")) throw new Error("Synthetic encryption failure");
        return codec.encryptString(value);
      },
    });
    if (returning) {
      settings.saveProvider({
        id: "chatgpt",
        preset: "openai-chatgpt",
        name: "ChatGPT",
        baseUrl: "https://api.openai.com/v1",
        models: [{ id: "original", reasoning: false }],
      });
      settings.saveChatGPTCredential("chatgpt", credential("old"));
    }
    const files = ["credentials.enc"].map((file) => join(dir, file));
    const before = await Promise.all(files.map((file) => (existsSync(file) ? readFile(file) : undefined)));
    const previous = settings.get();
    const publicState = settings.state.getSetting("app");
    fail = true;
    login.wait.mockResolvedValue(credential("new"));
    const auth = new ChatGPTAuth(settings, async () =>
      Response.json({ models: [{ slug: "new-model", visibility: "list" }] }),
    );
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        const pending = await auth.begin(returning ? "chatgpt" : null);
        await expect(auth.complete(pending.loginId)).rejects.toThrow("Synthetic encryption failure");
        expect(settings.get()).toEqual(previous);
        expect(settings.state.getSetting("app")).toEqual(publicState);
        expect(new SettingsStore(dir, codec).get()).toEqual(previous);
        expect(
          await Promise.all(files.map((file) => (existsSync(file) ? readFile(file) : undefined))),
        ).toEqual(before);
      }
    } finally {
      auth.close();
    }
  },
);
