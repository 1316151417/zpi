import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { expect, it } from "vitest";
import { verifyIndependentSubscriptions } from "./subscription-live.ts";

it.each(["independent", "shared-client", "different-subject"] as const)(
  "exercises both real callback listeners and the release acceptance contract: %s",
  async (scenario) => {
    const keys = await generateKeyPair("RS256", { extractable: true });
    const jwk = { ...(await exportJWK(keys.publicKey)), kid: "test", alg: "RS256" };
    const issued = new Map<string, { client: string; token: string }>();
    const revoked = new Set<string>();
    const requests: string[] = [];
    const reports: string[] = [];
    const fetcher: typeof fetch = async (url, init) => {
      const endpoint = String(url);
      const params = new URLSearchParams(String(init?.body));
      if (endpoint.endsWith("/jwks.json")) return Response.json({ keys: [jwk] });
      if (endpoint.endsWith("/token")) {
        const code = String(params.get("code"));
        const registration = issued.get(code);
        if (!registration || registration.client !== params.get("client_id")) throw new Error("bad exchange");
        return Response.json({
          access_token: code,
          refresh_token: code,
          scope: "openid chatgpt.tokens.use.direct",
          expires_in: 3600,
          id_token: registration.token,
        });
      }
      if (endpoint.endsWith("/revoke")) {
        const token = String(params.get("token"));
        if (issued.get(token)?.client !== params.get("client_id")) throw new Error("wrong revocation target");
        revoked.add(token);
        requests.push(`revoke ${token}`);
        return new Response(null, { status: 200 });
      }
      const who = new Headers(init?.headers).get("authorization")?.slice(7) ?? "";
      if (!issued.has(who) || revoked.has(who)) return Response.json({ error: "revoked" }, { status: 401 });
      if (endpoint.endsWith("/models"))
        return Response.json({ models: [{ slug: "probe", visibility: "list", input_modalities: ["text"] }] });
      if (endpoint.endsWith("/responses")) {
        requests.push(`model ${who}`);
        const done = {
          type: "response.completed",
          response: {
            id: "resp",
            model: "probe",
            status: "completed",
            output: [
              {
                id: "text1",
                role: "assistant",
                type: "message",
                content: [{ type: "output_text", text: "OK" }],
              },
            ],
          },
        };
        return new Response(`data: ${JSON.stringify(done)}\n\n`, {
          headers: { "content-type": "text/event-stream" },
        });
      }
      throw new Error("Unexpected endpoint");
    };
    const acceptance = verifyIndependentSubscriptions({
      fetcher,
      signal: AbortSignal.timeout(7000),
      report: (s) => reports.push(s),
      authorize: async (label, url) => {
        const client = scenario === "shared-client" ? "issued-same" : `issued-${label}`;
        const who = scenario === "different-subject" ? label : "test-user";
        const token = await new SignJWT({ nonce: url.searchParams.get("nonce") })
          .setProtectedHeader({ alg: "RS256", kid: "test" })
          .setIssuedAt()
          .setExpirationTime("1h")
          .setIssuer("https://auth.openai.com")
          .setSubject(who)
          .setAudience(client)
          .sign(keys.privateKey);
        issued.set(label, { client, token });
        const callback = new URL(String(url.searchParams.get("redirect_uri")));
        expect(callback.hostname).toBe("127.0.0.1");
        callback.search = new URLSearchParams({
          state: String(url.searchParams.get("state")),
          code: label,
          client_id: client,
        }).toString();
        const response = await fetch(callback);
        expect(response.status).toBe(200);
      },
    });
    if (scenario === "independent") {
      await acceptance;
      expect(requests).toEqual([
        "model Desktop",
        "model CLI",
        "revoke CLI",
        "model Desktop",
        "revoke Desktop",
      ]);
    } else {
      await expect(acceptance).rejects.toThrow("核对已验证");
      expect(requests.filter((r) => r.startsWith("model"))).toEqual([]);
    }
    expect([...revoked].sort()).toEqual(["CLI", "Desktop"]);
    expect(reports.join(" ")).not.toMatch(/issued-|test-user|Bearer|client_id=|state=/);
  },
);
