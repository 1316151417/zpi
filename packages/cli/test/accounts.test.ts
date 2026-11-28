import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { ChatGPTCredential } from "@zpi-dev/ai/auth/openai-chatgpt";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterEach, expect, it, vi } from "vitest";
import { Accounts, type LoginInteraction } from "../src/accounts/index.ts";
import { serviceFor } from "../src/accounts/services.ts";
import type { SecretStore } from "../src/accounts/store.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const root of dirs.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(fetcher: typeof fetch, env: NodeJS.ProcessEnv = {}) {
  const root = mkdtempSync(join(tmpdir(), "zpi-cli-accounts-"));
  dirs.push(root);
  const values = new Map<string, string>();
  const secrets: SecretStore = {
    get: (key) => values.get(key) ?? null,
    set: (key, value) => {
      values.set(key, value);
    },
    delete: (key) => {
      values.delete(key);
    },
  };
  const open = () => new Accounts(root, { secrets, fetch: fetcher, env });
  return { root, accounts: open(), secrets, values, open };
}

const allModels: LoginInteraction = {
  authorize: async () => {
    throw new Error("Unexpected OAuth");
  },
  manualModels: async () => {
    throw new Error("Unexpected manual model entry");
  },
  warn: () => undefined,
};

it("resolves active, pinned and explicit model/account selections across reopened CLI instances", async () => {
  const { root, accounts, open, values } = fixture(async () =>
    Response.json({ data: ["vendor/read", "write"] }),
  );
  const gateway = serviceFor("team", "key", {
    api: "openai-responses",
    baseUrl: "https://model.example/v1/",
  });
  const a = await accounts.connect(
    gateway,
    "personal",
    { kind: "key", value: "personal-secret-marker" },
    allModels,
  );
  const b = await open().connect(gateway, "work", { kind: "key", value: "work-secret-marker" }, allModels);
  const first = await open().selectModel();
  expect(first.binding).toEqual({ provider: "team", modelId: "vendor/read", accountId: a.id });
  expect(first.model).toMatchObject({ baseUrl: "https://model.example/v1", api: "openai-responses" });
  expect(accounts.availableModels().map((m) => m.id)).toEqual(["team/vendor/read", "team/write"]);
  accounts.switchAccount("team", "work");
  const pinned = await open().selectModel(undefined, first.binding);
  expect(pinned.binding).toEqual(first.binding);
  expect((await open().selectModel("team/vendor/read", first.binding)).binding.accountId).toBe(b.id);
  accounts.setDefault("team/write");
  expect((await open().selectModel()).model.id).toBe("write");
  await open().logout(b.id);
  expect(accounts.availableModels()).toEqual([]);
  await expect(accounts.selectModel()).rejects.toThrow("尚未激活");
  expect((await open().selectModel(undefined, first.binding)).binding.accountId).toBe(a.id);
  await open().logout(a.id);
  await expect(open().selectModel(undefined, first.binding)).rejects.toThrow("移除");
  expect(values.size).toBe(0);
  expect(readFileSync(join(root, "accounts.sqlite")).includes(Buffer.from("secret-marker"))).toBe(false);
});

it("requires explicit env bindings, preserves a valid account after rejection, and allows manual models only for a missing catalog", async () => {
  let status = 200;
  const received: { url: string; key: string | null }[] = [];
  const env = { ONLY_HERE: "private-marker", ANTHROPIC_API_KEY: "ambient" };
  const { accounts, values } = fixture(async (url, options) => {
    received.push({ url: String(url), key: new Headers(options?.headers).get("x-api-key") });
    return Response.json({ data: ["alpha"] }, { status });
  }, env);
  const service = serviceFor("anthropic", "key");
  const saved = await accounts.connect(service, "work", { kind: "env", name: "ONLY_HERE" }, allModels);
  expect(received[0]).toEqual({ url: "https://api.anthropic.com/v1/models", key: "private-marker" });
  expect(values.size).toBe(0);
  env.ONLY_HERE = "";
  await expect(accounts.selectModel()).rejects.toThrow("ONLY_HERE");
  status = 401;
  await expect(
    accounts.connect(service, "work", { kind: "key", value: "invalid" }, allModels),
  ).rejects.toThrow("拒绝");
  expect(accounts.snapshot.accounts).toEqual([saved]);
  expect(values.size).toBe(0);
  const custom = serviceFor("local", "key", {
    api: "openai-completions",
    baseUrl: "http://localhost:1234/v1",
  });
  const manual: LoginInteraction = {
    ...allModels,
    manualModels: async (previous) => {
      expect(previous).toEqual([]);
      return ["first", "org/second"].map((id) => ({ id, contextWindow: 32000, maxTokens: 2000 }));
    },
  };
  await expect(accounts.connect(custom, "home", { kind: "none" }, manual)).rejects.toThrow("拒绝");
  status = 404;
  await accounts.connect(custom, "home", { kind: "none" }, manual);
  const selected = await accounts.selectModel("local/org/second");
  expect(selected.model).toMatchObject({ api: "openai-completions", contextWindow: 32000, maxTokens: 2000 });
  expect((await selected.runtime.getAvailable()).map((m) => m.id)).toEqual(["org/second"]);
  expect(values.size).toBe(0);
  expect(() => serviceFor("openai-api", "key", custom)).toThrow();
  expect(() => serviceFor("local", "oauth", custom)).toThrow();
  expect(() => serviceFor("local", "key", { ...custom, baseUrl: "https://key@example.test/v1" })).toThrow();
});

async function oauthFixture() {
  const keys = await generateKeyPair("RS256", { extractable: true });
  const jwk = { ...(await exportJWK(keys.publicKey)), alg: "RS256", kid: "cli-test" };
  const provider = {
    audience: "issued-cli-client",
    subject: "test-user",
    modelStatus: 200,
    refreshes: 0,
    revoked: [] as string[],
  };
  const urls: URL[] = [];
  let jwt = "";
  const sign = (nonce?: string) =>
    new SignJWT({ nonce })
      .setIssuer("https://auth.openai.com")
      .setSubject(provider.subject)
      .setAudience(provider.audience)
      .setProtectedHeader({ alg: "RS256", kid: "cli-test" })
      .setExpirationTime("1h")
      .setIssuedAt()
      .sign(keys.privateKey);
  const fetcher: typeof fetch = async (url, options) => {
    if (String(url).endsWith("/jwks.json")) return Response.json({ keys: [jwk] });
    const body = new URLSearchParams(String(options?.body));
    if (String(url).endsWith("/token")) {
      expect(body.get("client_id")).toBe("issued-cli-client");
      if (body.get("grant_type") === "refresh_token") {
        expect(body.get("refresh_token")).toBe("private-original-refresh");
        provider.refreshes++;
        await delay(15);
        return Response.json({
          access_token: "private-renewed",
          refresh_token: "private-rotated",
          expires_in: 3600,
          scope: "chatgpt.tokens.use.direct",
          id_token: await sign(),
        });
      }
      expect(body.get("code_verifier")).toHaveLength(43);
      return Response.json({
        access_token: "private-original",
        refresh_token: "private-original-refresh",
        expires_in: 3600,
        scope: "chatgpt.tokens.use.direct",
        id_token: jwt,
      });
    }
    if (String(url).endsWith("/models")) {
      const headers = new Headers(options?.headers);
      if (headers.get("authorization") === "Bearer private-paid-key")
        return Response.json({ data: [{ id: "gpt-5" }] });
      return Response.json(
        {
          models: [
            { slug: "example-gpt", visibility: "list" },
            { slug: "hidden", visibility: "hide" },
          ],
        },
        { status: provider.modelStatus },
      );
    }
    if (String(url).endsWith("/revoke")) {
      provider.revoked.push(String(body));
      return new Response(null, { status: 200 });
    }
    throw new Error("Unexpected endpoint");
  };
  const base = fixture(fetcher);
  const ui: LoginInteraction = {
    ...allModels,
    authorize: async (login) => {
      const url = new URL(login.url);
      urls.push(url);
      jwt = await sign(url.searchParams.get("nonce") ?? undefined);
      const callback = new URL(String(url.searchParams.get("redirect_uri")));
      callback.search = new URLSearchParams({
        code: "test-code",
        state: String(url.searchParams.get("state")),
        client_id: "issued-cli-client",
      }).toString();
      login.submitCallback(callback.href);
      return login.wait();
    },
  };
  const connect = (reuse?: boolean) =>
    base.accounts.connect(serviceFor("openai", "oauth"), "personal", { kind: "oauth", reuse }, ui);
  return { ...base, provider, urls, connect, ui };
}

it("uses its own registration and verified OAuth account, rejects the wrong audience, and leaves the paid API account separate", async () => {
  const f = await oauthFixture();
  const saved = await f.connect();
  expect(f.urls[0].searchParams.get("ext_agent_host_id")).toMatch(/^urn:uuid:/);
  expect(f.urls[0].searchParams.get("client_id")).toBe("dynamic_agent_client");
  expect(f.urls[0].searchParams.get("agent_name_hint")).toBe("ZPI CLI");
  expect(f.accounts.availableModels().map((m) => m.id)).toEqual(["openai/example-gpt"]);
  const original = await f.accounts.selectModel();
  expect(original.model.auth).toBe("chatgpt");
  f.provider.audience = "issued-by-different-app";
  await expect(f.connect()).rejects.toThrow("登录未完成");
  expect(f.urls[1].searchParams.get("client_id")).toBe("issued-cli-client");
  expect(f.urls[1].searchParams.has("agent_name_hint")).toBe(false);
  expect(f.urls[1].searchParams.get("ext_agent_host_id")).toBe(
    f.urls[0].searchParams.get("ext_agent_host_id"),
  );
  expect(f.accounts.snapshot.accounts).toEqual([saved]);
  expect(f.values.size).toBe(1);
  const cancel: LoginInteraction = {
    ...f.ui,
    authorize: async (login) => {
      login.cancel();
      return login.wait();
    },
  };
  await expect(
    f.accounts.connect(serviceFor("openai", "oauth"), "personal", { kind: "oauth" }, cancel),
  ).rejects.toThrow("取消");
  const api = await f.accounts.connect(
    serviceFor("openai", "key"),
    "work",
    { kind: "key", value: "private-paid-key" },
    allModels,
  );
  f.accounts.switchAccount("openai", "work");
  expect((await f.accounts.selectModel(undefined, original.binding)).model.auth).toBe("chatgpt");
  expect((await f.accounts.selectModel(`openai/${api.models[0].id}`)).model.auth).toBeUndefined();
  await f.accounts.logout(saved.id);
  expect(f.provider.revoked).toHaveLength(1);
  expect(new URLSearchParams(f.provider.revoked[0]).get("client_id")).toBe("issued-cli-client");
  expect(f.values.size).toBe(1);
  await expect(f.open().selectModel(undefined, original.binding)).rejects.toThrow("已移除");
  expect(JSON.stringify(f.accounts.snapshot)).not.toContain("private-");
});

it("recovers listed subscription models after discovery failure without requiring another OAuth login", async () => {
  const f = await oauthFixture();
  f.provider.modelStatus = 503;
  const saved = await f.connect();
  expect(saved.models).toEqual([]);
  f.provider.modelStatus = 200;
  const read = vi.spyOn(f.secrets, "get");
  const refreshed = await f.connect(true);
  expect(read).toHaveBeenCalledTimes(1);
  expect(refreshed.id).toBe(saved.id);
  expect(f.urls.length).toBe(1);
  expect((await f.accounts.selectModel()).model.id).toBe("example-gpt");
});

it("serializes rotations between independent connections and resumes identity verification after an interrupted final save", async () => {
  const f = await oauthFixture();
  const account = await f.connect();
  if (account.credential.kind !== "oauth") throw new Error("expected oauth");
  const ref = account.credential.ref;
  const expire = () => {
    const raw = f.values.get(ref);
    if (!raw) throw new Error("missing test state");
    const value: ChatGPTCredential = JSON.parse(raw);
    f.values.set(ref, JSON.stringify({ ...value, expires: 1 }));
  };
  expire();
  const writes: ChatGPTCredential[] = [];
  const store = f.secrets.set.bind(f.secrets);
  const spy = vi.spyOn(f.secrets, "set").mockImplementation((key, value) => {
    const credential: ChatGPTCredential = JSON.parse(value);
    writes.push(credential);
    if (!credential.identityPending) throw new Error("interrupted");
    store(key, value);
  });
  await expect(f.open().selectModel()).rejects.toThrow("interrupted");
  expect(writes[0]).toMatchObject({ refresh: "private-rotated", identityPending: true });
  spy.mockRestore();
  const selections = await Promise.all([f.open().selectModel(), f.open().selectModel()]);
  expect(selections.map((s) => s.model.id)).toEqual(["example-gpt", "example-gpt"]);
  expect(f.provider.refreshes).toBe(1);
  expect(JSON.parse(f.values.get(ref) ?? "{}").identityPending).toBeUndefined();
  const original = JSON.parse(f.values.get(ref) ?? "{}") as ChatGPTCredential;
  f.values.set(ref, JSON.stringify({ ...original, refresh: "private-original-refresh", expires: 1 }));
  await Promise.all([f.open().selectModel(), f.open().selectModel(), f.open().selectModel()]);
  expect(f.provider.refreshes).toBe(2);
  await f.accounts.logout(account.id);
  expect(new URLSearchParams(f.provider.revoked[0]).get("token")).toBe("private-rotated");
});

it("checks long-lived runtimes against the pinned account before every model request", async () => {
  const endpoints: string[] = [];
  const f = fixture(async (url) => {
    endpoints.push(String(url));
    return Response.json({ data: ["first"] });
  });
  const first = serviceFor("team", "key", { api: "openai-responses", baseUrl: "https://first.example/v1" });
  const second = serviceFor("team", "key", { api: "openai-responses", baseUrl: "https://second.example/v1" });
  await f.accounts.connect(first, "work", { kind: "key", value: "first-private-key" }, allModels);
  const selected = await f.accounts.selectModel("team/first");
  await f.accounts.connect(second, "work", { kind: "key", value: "second-private-key" }, allModels);
  const result = await selected.runtime.streamSimple(selected.model, { messages: [] }).result();
  expect(result).toMatchObject({ stopReason: "error", errorMessage: expect.stringContaining("重新选择") });
  const rebound = await f.accounts.selectModel("team/first");
  await f.accounts.logout(rebound.binding.accountId);
  expect(await rebound.runtime.streamSimple(rebound.model, { messages: [] }).result()).toMatchObject({
    stopReason: "error",
    errorMessage: expect.stringContaining("移除"),
  });
  expect(endpoints).toEqual(["https://first.example/v1/models", "https://second.example/v1/models"]);
});

it("recovers from denied keyring access using explicit environment credentials and rejects reserved subscription aliases", async () => {
  const f = fixture(async () => Response.json({ data: ["a"] }), { SUPPLIED: "explicit-value" });
  vi.spyOn(f.secrets, "get").mockImplementation(() => {
    throw new Error("密钥库不可用");
  });
  const local = serviceFor("local", "key", { api: "openai-completions", baseUrl: "http://localhost:8899" });
  await expect(
    f.accounts.connect(local, "work", { kind: "key", value: "not-saved" }, allModels),
  ).rejects.toThrow("密钥库不可用");
  await expect(
    f.accounts.connect(serviceFor("openai", "oauth"), "work", { kind: "oauth" }, allModels),
  ).rejects.toThrow("密钥库不可用");
  expect(f.accounts.snapshot.accounts).toEqual([]);
  await f.accounts.connect(local, "work", { kind: "env", name: "SUPPLIED" }, allModels);
  expect((await f.accounts.selectModel()).model.id).toBe("a");
  expect(() => serviceFor("openai-chatgpt", "key", local)).toThrow();
  expect(() => serviceFor("local", "oauth", local)).toThrow();
});

it("keeps existing credentials and default selection after failed verification or cancellation during discovery", async () => {
  let status = 200;
  const f = fixture(async () => Response.json({ data: ["a", "b"] }, { status }));
  const provider = serviceFor("deepseek", "key");
  const saved = await f.accounts.connect(
    provider,
    "work",
    { kind: "key", value: "original-secret" },
    allModels,
  );
  status = 503;
  await expect(
    f.accounts.connect(provider, "work", { kind: "key", value: "replacement" }, allModels),
  ).rejects.toThrow("模型发现失败");
  status = 200;
  await expect(
    f.accounts.connect(
      provider,
      "work",
      { kind: "key", value: "replacement" },
      {
        ...allModels,
        signal: AbortSignal.abort(new Error("cancelled")),
      },
    ),
  ).rejects.toThrow("cancelled");
  expect(f.accounts.snapshot.accounts).toEqual([saved]);
  expect(f.accounts.snapshot.defaultModel).toBe("deepseek/a");
  expect([...f.values.values()]).toEqual(["original-secret"]);
});

it("coordinates the same account across processes, releasing its advisory lock when the owner dies", async () => {
  const f = fixture(async () => Response.json({ data: ["model"] }));
  const module = new URL("../src/accounts/store.ts", import.meta.url).href;
  const script = `
    import { AccountStore } from ${JSON.stringify(module)};
    const store = new AccountStore(process.argv[1]);
    await store.withAccount("gateway", "work", async () => {
      process.send("locked");
      await new Promise(() => { setInterval(() => {}, 60_000); });
    });
  `;
  const child = spawn(
    process.execPath,
    ["--disable-warning=ExperimentalWarning", "--input-type=module", "-e", script, f.root],
    { stdio: ["ignore", "ignore", "ignore", "ipc"] },
  );
  const exit = once(child, "exit");
  try {
    expect((await Promise.race([once(child, "message"), exit]))[0]).toBe("locked");
    const service = serviceFor("gateway", "key", {
      api: "openai-responses",
      baseUrl: "http://localhost:9801/v1",
    });
    let finished = false;
    const pending = f.accounts.connect(service, "work", { kind: "none" }, allModels).then(() => {
      finished = true;
    });
    await f.open().connect(service, "personal", { kind: "none" }, allModels);
    expect(finished).toBe(false);
    child.kill("SIGKILL");
    await exit;
    await pending;
    expect(f.accounts.snapshot.accounts.map((a) => a.name).sort()).toEqual(["personal", "work"]);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await exit;
  }
});
