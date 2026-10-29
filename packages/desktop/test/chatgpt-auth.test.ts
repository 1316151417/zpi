import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterEach, expect, it, vi } from "vitest";
import { fetchProviderModels } from "zpi-ai";
import { beginChatGPTLogin, type ChatGPTCredential, verifyChatGPTIdentity } from "zpi-ai/auth/openai-chatgpt";
import { ChatGPTAuth } from "../src/main/chatgpt-auth.ts";
import { SettingsStore } from "../src/main/storage.ts";

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  await Promise.allSettled(
    cleanup
      .splice(0)
      .reverse()
      .map((fn) => fn()),
  );
  vi.restoreAllMocks();
});
const codec = {
  isEncryptionAvailable: () => true,
  encryptString: (value: string) => Buffer.from(value),
  decryptString: (value: Buffer) => value.toString(),
};
async function store() {
  const dir = await mkdtemp(join(tmpdir(), "zpi-chatgpt-"));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  return { dir, settings: new SettingsStore(dir, codec) };
}
const credential = (): ChatGPTCredential => ({
  access: "private-access",
  refresh: "private-refresh",
  expires: Date.now() + 3600000,
  clientId: "oaiapp_test",
  subject: "user",
  idToken: "private-id-token",
  email: "account@example.com",
  scopes: ["chatgpt.tokens.use.direct"],
});
async function signedIdentity(kid: string, subject = "user") {
  const keys = await generateKeyPair("RS256", { extractable: true });
  const jwk = { ...(await exportJWK(keys.publicKey)), kid, alg: "RS256" };
  const jwt = await new SignJWT({})
    .setProtectedHeader({ alg: "RS256", kid })
    .setIssuer("https://auth.openai.com")
    .setAudience("oaiapp_test")
    .setSubject(subject)
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(keys.privateKey);
  return { jwk, jwt };
}
function add(settings: SettingsStore) {
  settings.saveProvider({
    id: "chatgpt",
    preset: "openai-chatgpt",
    name: "ChatGPT",
    baseUrl: "https://api.openai.com/v1",
    models: [{ id: "fake", reasoning: false }],
  });
  settings.saveChatGPTCredential("chatgpt", credential());
}

it("uses dynamic registration, validates state and OIDC identity, discovers account models and preserves issued clients across sign out", async () => {
  const { dir, settings } = await store();
  const keys = await generateKeyPair("RS256", { extractable: true });
  const jwk = { ...(await exportJWK(keys.publicKey)), kid: "test-key", alg: "RS256" };
  let idToken = "";
  const fetcher = (async (url, init) => {
    if (String(url).endsWith("jwks.json")) return Response.json({ keys: [jwk] });
    if (String(url).endsWith("/token")) {
      const body = new URLSearchParams(String(init?.body));
      expect(body.get("client_id")).toBe("oaiapp_test");
      expect(body.get("code_verifier")).toHaveLength(43);
      return Response.json({
        access_token: "private-access",
        refresh_token: "private-refresh",
        expires_in: 3600,
        scope: "openid chatgpt.tokens.use.direct",
        id_token: idToken,
      });
    }
    if (String(url).endsWith("/models"))
      return Response.json({
        models: [
          {
            slug: "fake",
            display_name: "Test model",
            visibility: "list",
            context_window: 100000,
            max_output_tokens: 10000,
            input_modalities: ["text", "image"],
            supported_reasoning_levels: [
              { effort: "none" },
              { effort: "low" },
              { effort: "high" },
              { effort: "xhigh" },
            ],
          },
          { slug: "hidden", visibility: "hide" },
        ],
      });
    if (String(url).endsWith("/revoke")) return new Response(null, { status: 200 });
    throw new Error("Unexpected URL");
  }) as typeof fetch;
  const auth = new ChatGPTAuth(settings, fetcher);
  cleanup.push(() => auth.close());
  const first = await auth.begin(null);
  const url = new URL(first.url);
  expect(url.searchParams.get("client_id")).toBe("dynamic_agent_client");
  expect(url.searchParams.get("agent_name_hint")).toBe("ZPI");
  expect(url.searchParams.get("ext_agent_host_id")).toBe(settings.getChatGPTHostId());
  const callback = new URL(url.searchParams.get("redirect_uri") ?? "");
  callback.search = new URLSearchParams({
    code: "code",
    state: "wrong",
    client_id: "oaiapp_test",
  }).toString();
  expect(() => auth.submit(first.loginId, callback.href)).toThrow("state");
  callback.searchParams.set("state", url.searchParams.get("state") ?? "");
  idToken = await new SignJWT({ nonce: url.searchParams.get("nonce"), email: "account@example.com" })
    .setProtectedHeader({ alg: "RS256", kid: "test-key" })
    .setIssuer("https://auth.openai.com")
    .setSubject("user")
    .setAudience("oaiapp_test")
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(keys.privateKey);
  const completing = auth.complete(first.loginId);
  // Real loopback callback, with the same path and dynamically selected port used in exchange.
  expect((await fetch(callback)).status).toBe(200);
  const result = await completing;
  expect(result.warning).toContain("账号可用性待验证");
  expect(result.settings.providers[0]).toMatchObject({
    chatgptAccount: { connected: true },
    hasApiKey: false,
  });
  expect(result.settings.providers[0].models.find((model) => model.id === "fake")).toMatchObject({
    id: "fake",
    name: "Test model",
    input: ["text", "image"],
    thinkingLevelMap: { off: "none", xhigh: "xhigh", max: null },
  });
  expect(result.settings.providers[0].models).toHaveLength(5);
  expect(JSON.stringify(result.settings)).not.toContain("private-");
  expect(JSON.stringify(settings.state.getSetting("app"))).not.toContain("private-");
  expect(settings.getProviderCredentials(result.providerId)).toEqual({ apiKey: "" });
  expect(await new SettingsStore(dir, codec).getRequestApiKey(result.providerId)).toBe("private-access");
  await auth.disconnect(result.providerId);
  await expect(settings.getRequestApiKey(result.providerId)).rejects.toThrow("先登录");
  const returning = await auth.begin(result.providerId);
  const returningUrl = new URL(returning.url);
  expect(returningUrl.searchParams.get("client_id")).toBe("oaiapp_test");
  expect(returningUrl.searchParams.has("agent_name_hint")).toBe(false);
  expect(returningUrl.searchParams.get("ext_agent_host_id")).toBe(url.searchParams.get("ext_agent_host_id"));
  auth.cancel(returning.loginId);
  const reopened = new SettingsStore(dir, codec);
  expect(reopened.getChatGPTHostId()).toBe(settings.getChatGPTHostId());
  expect(reopened.get().providers[0].chatgptAccount?.connected).toBe(false);
});

it("rejects invalid JWT signature, nonce, audience and returning identity", async () => {
  const keys = await generateKeyPair("RS256", { extractable: true });
  const jwk = { ...(await exportJWK(keys.publicKey)), kid: "test" };
  const fetcher = (async () => Response.json({ keys: [jwk] })) as typeof fetch;
  const jwt = await new SignJWT({ nonce: "nonce" })
    .setProtectedHeader({ alg: "RS256", kid: "test" })
    .setIssuer("https://auth.openai.com")
    .setAudience("client")
    .setSubject("user")
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(keys.privateKey);
  await expect(verifyChatGPTIdentity(jwt, "client", "wrong", fetcher)).rejects.toThrow();
  await expect(verifyChatGPTIdentity(jwt, "other", "nonce", fetcher)).rejects.toThrow();
  const other = await generateKeyPair("RS256", { extractable: true });
  const forged = await new SignJWT({ nonce: "nonce" })
    .setProtectedHeader({ alg: "RS256", kid: "test" })
    .setIssuer("https://auth.openai.com")
    .setAudience("client")
    .setSubject("user")
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(other.privateKey);
  await expect(verifyChatGPTIdentity(forged, "client", "nonce", fetcher)).rejects.toThrow();
});

it("serializes rotating refreshes and never resurrects a disconnected account", async () => {
  const { dir, settings } = await store();
  add(settings);
  settings.saveChatGPTCredential("chatgpt", { ...credential(), expires: 1 });
  let count = 0;
  const fetcher = (async (_url, init) => {
    count++;
    const body = new URLSearchParams(String(init?.body));
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("resource")).toBe("https://api.openai.com/v1");
    expect(body.has("scope")).toBe(false);
    return Response.json({
      access_token: "renewed-access",
      refresh_token: "rotated-refresh",
      expires_in: 3600,
      scope: "chatgpt.tokens.use.direct",
    });
  }) as typeof fetch;
  expect(
    await Promise.all([
      settings.getRequestApiKey("chatgpt", fetcher),
      settings.getRequestApiKey("chatgpt", fetcher),
    ]),
  ).toEqual(["renewed-access", "renewed-access"]);
  expect(count).toBe(1);
  expect(new SettingsStore(dir, codec).getChatGPTCredential("chatgpt")?.refresh).toBe("rotated-refresh");
  settings.saveChatGPTCredential("chatgpt", { ...credential(), expires: 1 });
  let release!: (response: Response) => void;
  const pending = settings.getRequestApiKey(
    "chatgpt",
    (() =>
      new Promise<Response>((resolve) => {
        release = resolve;
      })) as typeof fetch,
  );
  settings.disconnectChatGPT("chatgpt");
  release(
    Response.json({
      access_token: "bad",
      refresh_token: "bad",
      expires_in: 3600,
      scope: "chatgpt.tokens.use.direct",
    }),
  );
  await expect(pending).rejects.toThrow("状态已改变");
  expect(settings.get().providers[0].chatgptAccount?.connected).toBe(false);
});

it("saves rotated credentials without depending on an unchanged settings database write", async () => {
  const { dir, settings } = await store();
  add(settings);
  settings.saveChatGPTCredential("chatgpt", { ...credential(), expires: 1 });
  const publicState = settings.state.getSetting("app");
  const writeSettings = vi.spyOn(settings.state, "setSetting").mockImplementation(() => {
    throw new Error("Synthetic database failure");
  });
  const fetcher = vi.fn(async () =>
    Response.json({
      access_token: "renewed-access",
      refresh_token: "rotated-refresh",
      expires_in: 3600,
      scope: "chatgpt.tokens.use.direct",
    }),
  );
  await expect(settings.getRequestApiKey("chatgpt", fetcher)).resolves.toBe("renewed-access");
  expect(writeSettings).not.toHaveBeenCalled();
  expect(settings.state.getSetting("app")).toEqual(publicState);
  const reopened = new SettingsStore(dir, codec);
  cleanup.push(() => reopened.close());
  expect(reopened.getChatGPTCredential("chatgpt")?.refresh).toBe("rotated-refresh");
  await expect(settings.getRequestApiKey("chatgpt", fetcher)).resolves.toBe("renewed-access");
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it.each([429, 503])(
  "preserves saved credentials after HTTP %s and allows the next refresh",
  async (status) => {
    const { settings } = await store();
    add(settings);
    const original = { ...credential(), expires: 1 };
    settings.saveChatGPTCredential("chatgpt", original);
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status }))
      .mockResolvedValueOnce(
        Response.json({
          access_token: "renewed-access",
          refresh_token: "rotated-refresh",
          expires_in: 3600,
          scope: "chatgpt.tokens.use.direct",
        }),
      );
    await expect(settings.getRequestApiKey("chatgpt", fetcher)).rejects.toThrow("稍后重试");
    expect(settings.getChatGPTCredential("chatgpt")).toEqual(original);
    await expect(settings.getRequestApiKey("chatgpt", fetcher)).resolves.toBe("renewed-access");
    expect(fetcher).toHaveBeenCalledTimes(2);
  },
);

it("does not fall back to a static catalog on account discovery failures; rejects API-key substitution", async () => {
  await expect(
    fetchProviderModels(
      { preset: "openai-chatgpt", apiKey: "private" },
      (async () => new Response("private", { status: 401 })) as typeof fetch,
    ),
  ).rejects.toThrow("无法获取模型");
  const { settings } = await store();
  add(settings);
  expect(() => settings.saveProvider({ ...settings.snapshot("chatgpt"), apiKey: "replacement" })).toThrow(
    "登录授权",
  );
  const login = await beginChatGPTLogin({ hostId: settings.getChatGPTHostId(), timeoutMs: 20 });
  await expect(login.wait()).rejects.toThrow("超时");
});

it("rejects missing plan permission and returning account mismatches before replacing saved credentials", async () => {
  const { settings } = await store();
  add(settings);
  const keys = await generateKeyPair("RS256", { extractable: true });
  const jwk = { ...(await exportJWK(keys.publicKey)), kid: "test" };
  let idToken = "",
    scope = "openid";
  const fetcher = (async (url) => {
    if (String(url).endsWith("jwks.json")) return Response.json({ keys: [jwk] });
    return Response.json({
      access_token: "must-not-replace",
      refresh_token: "must-not-replace",
      expires_in: 3600,
      scope,
      id_token: idToken,
    });
  }) as typeof fetch;
  const auth = new ChatGPTAuth(settings, fetcher);
  cleanup.push(() => auth.close());
  for (const mismatch of [false, true]) {
    const attempt = await auth.begin("chatgpt");
    const url = new URL(attempt.url);
    idToken = await new SignJWT({ nonce: url.searchParams.get("nonce") })
      .setProtectedHeader({ alg: "RS256", kid: "test" })
      .setIssuer("https://auth.openai.com")
      .setAudience("oaiapp_test")
      .setSubject(mismatch ? "another-user" : "user")
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(keys.privateKey);
    const completion = auth.complete(attempt.loginId);
    const callback = new URL(url.searchParams.get("redirect_uri") ?? "");
    callback.search = new URLSearchParams({
      code: "code",
      state: url.searchParams.get("state") ?? "",
    }).toString();
    auth.submit(attempt.loginId, callback.href);
    await expect(completion).rejects.toThrow("登录未完成");
    expect(settings.getChatGPTCredential("chatgpt")?.access).toBe("private-access");
    scope = "chatgpt.tokens.use.direct";
  }
});

it("clears local tokens and reports when remote sign-out cannot be confirmed", async () => {
  const { settings } = await store();
  add(settings);
  let calls = 0;
  const auth = new ChatGPTAuth(settings, (async () => {
    calls++;
    return new Response(null, { status: 503, headers: { "retry-after-ms": "1" } });
  }) as typeof fetch);
  const result = await auth.disconnect("chatgpt");
  expect(calls).toBe(2);
  expect(result.warning).toContain("无法确认远端撤销");
  expect(result.settings.providers[0].chatgptAccount?.connected).toBe(false);
});

it("persists rotation before JWKS validation and resumes validation after reopening without rotating again", async () => {
  const { dir, settings } = await store();
  add(settings);
  settings.saveChatGPTCredential("chatgpt", { ...credential(), expires: 0 });
  const { jwk, jwt } = await signedIdentity("rotated");
  let tokenCalls = 0;
  let unavailable = true;
  const fetcher = vi.fn<typeof fetch>(async (url) => {
    if (String(url).endsWith("jwks.json"))
      return unavailable ? new Response(null, { status: 503 }) : Response.json({ keys: [jwk] });
    tokenCalls++;
    return Response.json({
      access_token: "rotated-access",
      refresh_token: "rotated-refresh",
      expires_in: 3600,
      scope: "chatgpt.tokens.use.direct",
      id_token: jwt,
    });
  });
  await expect(settings.getRequestApiKey("chatgpt", fetcher)).rejects.toThrow();
  const reopened = new SettingsStore(dir, codec);
  cleanup.push(() => reopened.close());
  expect(reopened.getChatGPTCredential("chatgpt")).toMatchObject({
    refresh: "rotated-refresh",
    identityPending: true,
  });
  await expect(reopened.getRequestApiKey("chatgpt", fetcher)).rejects.toThrow();
  unavailable = false;
  expect(await reopened.getRequestApiKey("chatgpt", fetcher)).toBe("rotated-access");
  expect(reopened.getChatGPTCredential("chatgpt")?.identityPending).toBeUndefined();
  expect(tokenCalls).toBe(1);
  const requests = fetcher.mock.calls.length;
  await verifyChatGPTIdentity(jwt, "oaiapp_test", undefined, fetcher);
  expect(fetcher).toHaveBeenCalledTimes(requests);
});

it("does not restore credentials after sign-out while rotated identity validation is pending", async () => {
  const { settings } = await store();
  add(settings);
  const { jwk, jwt } = await signedIdentity("pending");
  const validating = Promise.withResolvers<void>();
  const jwks = Promise.withResolvers<Response>();
  const fetcher = vi.fn<typeof fetch>(async (url) => {
    if (String(url).endsWith("jwks.json")) {
      validating.resolve();
      return jwks.promise;
    }
    return Response.json({
      access_token: "rotated-access",
      refresh_token: "rotated-refresh",
      expires_in: 3600,
      scope: "chatgpt.tokens.use.direct",
      id_token: jwt,
    });
  });
  const refresh = settings.getRequestApiKey("chatgpt", fetcher, "private-access");
  const assertion = expect(refresh).rejects.toThrow("登录状态已改变");
  await validating.promise;
  expect(settings.getChatGPTCredential("chatgpt")?.identityPending).toBe(true);
  settings.disconnectChatGPT("chatgpt");
  jwks.resolve(Response.json({ keys: [jwk] }));
  await assertion;
  await expect(settings.getRequestApiKey("chatgpt", fetcher)).rejects.toThrow("请先登录");
});

it("deduplicates forced refreshes of the rejected token and reuses a newer token", async () => {
  const { settings } = await store();
  add(settings);
  const fetcher = vi.fn<typeof fetch>(async () =>
    Response.json({
      access_token: "recovered",
      refresh_token: "rotated",
      expires_in: 3600,
      scope: "chatgpt.tokens.use.direct",
    }),
  );
  expect(await settings.getRequestApiKey("chatgpt", fetcher)).toBe("private-access");
  expect(fetcher).not.toHaveBeenCalled();
  expect(
    await Promise.all([
      settings.getRequestApiKey("chatgpt", fetcher, "private-access"),
      settings.getRequestApiKey("chatgpt", fetcher, "private-access"),
    ]),
  ).toEqual(["recovered", "recovered"]);
  expect(await settings.getRequestApiKey("chatgpt", fetcher, "private-access")).toBe("recovered");
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it("does not publish a rotated identity that belongs to another account", async () => {
  const { settings } = await store();
  add(settings);
  settings.saveChatGPTCredential("chatgpt", { ...credential(), expires: 0 });
  const { jwk, jwt } = await signedIdentity("other", "other-user");
  const fetcher = vi.fn<typeof fetch>(async (url) =>
    String(url).endsWith("jwks.json")
      ? Response.json({ keys: [jwk] })
      : Response.json({
          access_token: "wrong-account",
          refresh_token: "rotated",
          expires_in: 3600,
          scope: "chatgpt.tokens.use.direct",
          id_token: jwt,
        }),
  );
  await expect(settings.getRequestApiKey("chatgpt", fetcher)).rejects.toThrow("账号不匹配");
  await expect(settings.getRequestApiKey("chatgpt", fetcher)).rejects.toThrow("账号不匹配");
  settings.disconnectChatGPT("chatgpt");
  await expect(settings.getRequestApiKey("chatgpt", fetcher)).rejects.toThrow("请先登录");
});
