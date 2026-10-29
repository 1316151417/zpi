import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { expect, it, vi } from "vitest";
import { fakeModel } from "../../../tests/fake-server.ts";
import { type ChatGPTCredential, refreshChatGPTCredential } from "../src/auth/openai-chatgpt.ts";
import { streamSimple } from "../src/stream.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

const credential: ChatGPTCredential = {
  access: "synthetic-access",
  refresh: "synthetic-refresh",
  expires: 1,
  clientId: "oaiapp_test",
  subject: "user",
  idToken: "synthetic-id",
  scopes: ["chatgpt.tokens.use.direct"],
};

it.each([
  [400, "invalid_grant", "重新登录", false],
  [401, "invalid_refresh_token", "重新登录", false],
  [400, "token_expired", "重新登录", false],
  [400, "refresh_token_expired", "重新登录", false],
  [400, "refresh_token_invalidated", "重新登录", false],
  [400, "refresh_token_reused", "重新登录", false],
  [401, "invalid_client", "客户端", false],
  [429, undefined, "稍后重试", true],
  [503, "server_error", "稍后重试", true],
] as const)(
  "preserves refresh error %s/%s through the model request boundary",
  async (status, code, hint, retryable) => {
    const fetcher = vi.fn(async () =>
      Response.json(
        { error: code, error_description: credential.refresh, access_token: credential.access },
        { status, headers: { "retry-after": "2" } },
      ),
    );
    await expect(refreshChatGPTCredential(credential, fetcher)).rejects.toMatchObject({ status, code });
    const inference = vi.fn<typeof fetch>();
    const result = await streamSimple(
      fakeModel("https://example.invalid"),
      normalizeContext({ messages: [] }),
      {
        getApiKey: async () => (await refreshChatGPTCredential(credential, fetcher)).access,
        fetch: inference,
      },
    ).result();
    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toContain(hint);
    if (code) expect(result.errorMessage).toContain(code);
    expect(result.errorDetails).toMatchObject({ status, retryable, retryAfterMs: 2000 });
    expect(inference).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain("synthetic-");
  },
);

it("accepts nested error codes without exposing the error body", async () => {
  const fetcher = async () =>
    Response.json({ error: { code: "invalid_grant", message: credential.refresh } }, { status: 400 });
  await expect(refreshChatGPTCredential(credential, fetcher)).rejects.toMatchObject({
    status: 400,
    code: "invalid_grant",
    message: expect.stringContaining("重新登录"),
  });
});

it.each(["<html>synthetic-secret</html>", JSON.stringify({ error: "synthetic-secret" }), "null"])(
  "keeps HTTP recovery information for unrecognized error body %s",
  async (body) => {
    await expect(
      refreshChatGPTCredential(credential, async () => new Response(body, { status: 503 })),
    ).rejects.toMatchObject({
      status: 503,
      code: undefined,
      message: "provider: ChatGPT 授权失败（HTTP 503），授权服务暂时不可用，请稍后重试。",
    });
  },
);

it.each(["verified", "different-subject", "unavailable-keys"])(
  "validates replacement identity before returning rotated tokens (%s)",
  async (condition) => {
    const keys = await generateKeyPair("RS256", { extractable: true });
    const jwk = { ...(await exportJWK(keys.publicKey)), kid: "refresh-test" };
    const idToken = await new SignJWT({})
      .setProtectedHeader({ alg: "RS256", kid: "refresh-test" })
      .setIssuer("https://auth.openai.com")
      .setAudience(credential.clientId)
      .setSubject(condition === "different-subject" ? "other-user" : credential.subject)
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(keys.privateKey);
    const fetcher: typeof fetch = async (url) => {
      if (String(url).endsWith("jwks.json"))
        return condition === "unavailable-keys"
          ? new Response(null, { status: 503 })
          : Response.json({ keys: [jwk] });
      return Response.json({
        access_token: "renewed-access",
        refresh_token: "rotated-refresh",
        expires_in: 3600,
        scope: "chatgpt.tokens.use.direct",
        id_token: idToken,
      });
    };
    const result = refreshChatGPTCredential(credential, fetcher);
    if (condition === "verified")
      await expect(result).resolves.toMatchObject({
        refresh: "rotated-refresh",
        subject: credential.subject,
        idToken,
      });
    else await expect(result).rejects.toThrow();
  },
);
