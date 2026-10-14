import { expect, it, vi } from "vitest";
import { normalizeContext, streamSimple } from "zpi-ai";
import { fakeModel } from "../../../tests/fake-server.ts";
import { redactProviderError } from "../src/utils/redact-error.ts";

it.each(["anthropic-messages", "openai-completions", "openai-responses"] as const)(
  "redacts configured credentials and bare Bearer tokens from %s failures",
  async (api) => {
    const secrets = ["synthetic-api-key", "synthetic-model-token", "synthetic-request-token"];
    const fetcher = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            error: {
              type: "authentication_error",
              message: `Credential rejected: ${secrets.join(", ")}; Bearer ${secrets[1]}`,
            },
          }),
          { status: 401, headers: { "content-type": "application/json" } },
        ),
    );
    const result = await streamSimple(
      { ...fakeModel("https://example.invalid/v1"), api, headers: { Authorization: `Bearer ${secrets[1]}` } },
      normalizeContext({ messages: [] }),
      {
        apiKey: secrets[0],
        headers: { Authorization: `Bearer ${secrets[2]}` },
        fetch: fetcher,
        maxRetries: 0,
      },
    ).result();
    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toContain("Credential rejected");
    expect(result.errorMessage).toContain("[redacted]");
    for (const secret of secrets) expect(result.errorMessage).not.toContain(secret);
    expect(result.errorDetails?.status).toBe(401);
    expect(fetcher).toHaveBeenCalledTimes(1);
  },
);

it("redacts request-owned Bearer values without masking unrelated diagnostics", () => {
  expect(
    redactProviderError("Bad token unique-secret. Request failed with 401.", [
      undefined,
      null,
      "",
      "bearer unique-secret",
    ]),
  ).toBe("Bad token [redacted]. Request failed with 401.");
  expect(redactProviderError("Service unavailable", [])).toBe("Service unavailable");
});
