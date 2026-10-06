import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { createRemoteJWKSet, customFetch, jwtVerify } from "jose";
import { retryProviderRequest } from "../utils/provider-retry.ts";
import { isJsonObject } from "../utils/transcript.ts";

const issuer = "https://auth.openai.com";
const resource = "https://api.openai.com/v1";
const tokenUrl = `${issuer}/api/accounts/oauth/token`;
const directScope = "chatgpt.tokens.use.direct";
export interface ChatGPTCredential {
  access: string;
  refresh: string;
  expires: number;
  clientId: string;
  subject: string;
  email?: string;
  idToken: string;
  scopes: string[];
}
export function isChatGPTCredential(value: unknown): value is ChatGPTCredential {
  return (
    isJsonObject(value) &&
    [value.access, value.refresh, value.clientId, value.subject, value.idToken].every(
      (v) => typeof v === "string",
    ) &&
    typeof value.expires === "number" &&
    Number.isFinite(value.expires) &&
    value.clientId !== "dynamic_agent_client" &&
    Boolean(value.clientId && value.subject) &&
    Array.isArray(value.scopes) &&
    value.scopes.every((v) => typeof v === "string") &&
    (value.email === undefined || typeof value.email === "string")
  );
}
async function tokenRequest(body: URLSearchParams, fetcher: typeof fetch, signal?: AbortSignal) {
  const response = await fetcher(tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body,
    signal: AbortSignal.any([AbortSignal.timeout(20000), ...(signal ? [signal] : [])]),
    redirect: "error",
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`provider: ChatGPT 授权失败（HTTP ${response.status}），请重新登录。`);
  }
  const token: unknown = await response.json();
  if (
    !isJsonObject(token) ||
    typeof token.access_token !== "string" ||
    !token.access_token ||
    typeof token.refresh_token !== "string" ||
    !token.refresh_token ||
    typeof token.expires_in !== "number" ||
    !Number.isFinite(token.expires_in) ||
    token.expires_in <= 0 ||
    typeof token.scope !== "string" ||
    (token.token_type !== undefined && String(token.token_type).toLowerCase() !== "bearer")
  )
    throw new Error("provider: ChatGPT 返回了无效凭据");
  const scopes = token.scope.split(/\s+/).filter(Boolean);
  if (!scopes.includes(directScope))
    throw new Error("configuration: 尚未授权使用 ChatGPT 套餐，请重新登录并允许套餐访问。");
  return {
    token,
    access: token.access_token,
    refresh: token.refresh_token,
    expires: Date.now() + token.expires_in * 1000,
    scopes,
  };
}
export async function verifyChatGPTIdentity(
  idToken: string,
  clientId: string,
  nonce: string | undefined,
  fetcher: typeof fetch,
) {
  const keys = createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`), { [customFetch]: fetcher });
  const { payload } = await jwtVerify(idToken, keys, {
    issuer,
    audience: clientId,
    algorithms: ["RS256"],
    requiredClaims: ["sub", "exp", "iat"],
  });
  if (!payload.sub || (nonce !== undefined && payload.nonce !== nonce))
    throw new Error("provider: ChatGPT 登录身份验证失败");
  return { subject: payload.sub, ...(typeof payload.email === "string" ? { email: payload.email } : {}) };
}
export async function refreshChatGPTCredential(
  credential: ChatGPTCredential,
  fetcher: typeof fetch = fetch,
): Promise<ChatGPTCredential> {
  const result = await tokenRequest(
    new URLSearchParams({
      grant_type: "refresh_token",
      client_id: credential.clientId,
      refresh_token: credential.refresh,
      resource,
    }),
    fetcher,
  );
  let identity = { subject: credential.subject, ...(credential.email ? { email: credential.email } : {}) };
  let idToken = credential.idToken;
  if (typeof result.token.id_token === "string") {
    identity = await verifyChatGPTIdentity(result.token.id_token, credential.clientId, undefined, fetcher);
    if (identity.subject !== credential.subject)
      throw new Error("provider: ChatGPT 续期账号不匹配，请重新登录");
    idToken = result.token.id_token;
  }
  return {
    access: result.access,
    refresh: result.refresh,
    expires: result.expires,
    scopes: result.scopes,
    clientId: credential.clientId,
    ...identity,
    idToken,
  };
}
export async function revokeChatGPTCredential(
  credential: ChatGPTCredential,
  fetcher: typeof fetch = fetch,
): Promise<void> {
  if (!credential.refresh) return;
  await retryProviderRequest(
    async () => {
      let response: Response;
      try {
        response = await fetcher(`${issuer}/api/accounts/oauth/revoke`, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            client_id: credential.clientId,
            token: credential.refresh,
            token_type_hint: "refresh_token",
          }),
          signal: AbortSignal.timeout(5000),
          redirect: "error",
        });
      } catch {
        throw Object.assign(new Error("provider: ChatGPT 远端撤销请求失败"), {
          status: undefined,
          headers: undefined,
        });
      }
      await response.body?.cancel();
      if (!response.ok)
        throw Object.assign(new Error(`provider: 无法撤销 ChatGPT 会话（HTTP ${response.status}）`), {
          status: response.status,
          headers: response.headers,
        });
    },
    { maxRetries: 1, maxRetryDelayMs: 1000 },
  );
}
export interface ChatGPTLogin {
  url: string;
  wait(): Promise<ChatGPTCredential>;
  submitCallback(url: string): void;
  cancel(): void;
}
export async function beginChatGPTLogin(options: {
  hostId: string;
  credential?: ChatGPTCredential;
  fetch?: typeof fetch;
  timeoutMs?: number;
}): Promise<ChatGPTLogin> {
  if (!/^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(options.hostId))
    throw new Error("configuration: ChatGPT 安装标识无效");
  const fetcher = options.fetch ?? fetch;
  const random = () => randomBytes(32).toString("base64url");
  const state = random(),
    nonce = random(),
    verifier = random();
  const controller = new AbortController();
  let resolve!: (credential: ChatGPTCredential) => void;
  let reject!: (error: Error) => void;
  const result = new Promise<ChatGPTCredential>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  result.catch(() => undefined);
  let claimed = false,
    settled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const finish = (value: ChatGPTCredential | Error) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    server.close();
    server.closeIdleConnections();
    if (value instanceof Error) reject(value);
    else resolve(value);
  };
  let redirectUri = "";
  function accept(url: URL) {
    const expected = new URL(redirectUri);
    if (
      url.origin !== expected.origin ||
      url.pathname !== expected.pathname ||
      url.searchParams.get("state") !== state
    )
      throw new Error("invalid_input: ChatGPT 回调地址或 state 不匹配");
    if (claimed || settled) throw new Error("invalid_input: 此登录已处理或取消");
    if (url.searchParams.has("error")) {
      finish(new Error("provider: ChatGPT 授权被取消或拒绝"));
      return;
    }
    const code = url.searchParams.get("code");
    const clientId = url.searchParams.get("client_id") ?? options.credential?.clientId;
    if (
      !code ||
      !clientId ||
      clientId === "dynamic_agent_client" ||
      (options.credential && clientId !== options.credential.clientId)
    )
      throw new Error("invalid_input: ChatGPT 回调缺少 code 或有效 client_id");
    claimed = true;
    void (async () => {
      const response = await tokenRequest(
        new URLSearchParams({
          grant_type: "authorization_code",
          client_id: clientId,
          code,
          code_verifier: verifier,
          redirect_uri: redirectUri,
          resource,
        }),
        fetcher,
        controller.signal,
      );
      if (typeof response.token.id_token !== "string") throw new Error("provider: ChatGPT 未返回 ID token");
      const identity = await verifyChatGPTIdentity(response.token.id_token, clientId, nonce, fetcher);
      if (options.credential && options.credential.subject !== identity.subject)
        throw new Error("provider: ChatGPT 登录账号不匹配");
      finish({
        access: response.access,
        refresh: response.refresh,
        expires: response.expires,
        scopes: response.scopes,
        clientId,
        ...identity,
        idToken: response.token.id_token,
      });
    })().catch(() => finish(new Error("provider: ChatGPT 登录未完成，请检查套餐授权并重新登录。")));
  }
  const server = createServer((request, response) => {
    try {
      if (request.method !== "GET") throw new Error("Invalid method");
      accept(new URL(request.url ?? "/", redirectUri));
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      response.end(
        "<!doctype html><title>ZPI · ChatGPT</title><p>已收到授权回调，请返回 ZPI 查看登录结果。</p>",
      );
    } catch {
      response.writeHead(400, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
      response.end("无效或过期的登录回调，请返回 ZPI 重试。");
    }
  });
  await new Promise<void>((yes, no) => {
    server.once("error", no);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", no);
      yes();
    });
  });
  server.on("error", () => finish(new Error("provider: ChatGPT 回调监听失败")));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("provider: ChatGPT 回调端口不可用");
  redirectUri = `http://127.0.0.1:${address.port}/auth/callback`;
  timer = setTimeout(
    () => {
      controller.abort();
      finish(new Error("provider: ChatGPT 登录超时，请重试"));
      server.closeAllConnections();
    },
    options.timeoutMs ?? 5 * 60 * 1000,
  );
  const url = new URL(`${issuer}/api/accounts/authorize`);
  url.search = new URLSearchParams({
    client_id: options.credential?.clientId ?? "dynamic_agent_client",
    ...(!options.credential ? { agent_name_hint: "zpi" } : {}),
    ext_agent_host_id: options.hostId,
    response_type: "code",
    redirect_uri: redirectUri,
    resource,
    scope: `openid profile email offline_access resource.invoke ${directScope}`,
    state,
    nonce,
    code_challenge_method: "S256",
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
  }).toString();
  return {
    url: url.href,
    wait: () => result,
    submitCallback: (value) => accept(new URL(value.trim())),
    cancel: () => {
      controller.abort();
      finish(new Error("provider: 已取消 ChatGPT 登录"));
      server.closeAllConnections();
    },
  };
}
