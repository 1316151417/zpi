import { expect, it, vi } from "vitest";
import { normalizeContext, streamSimple } from "zpi-ai";
import { chunk, fakeModel } from "../../../tests/fake-server.ts";

const context = normalizeContext({ messages: [{ role: "user", content: "hello", timestamp: 1 }] });
const unauthorized = () => Response.json({ error: { message: "Unauthorized" } }, { status: 401 });
const success = () =>
  new Response(
    `data: ${JSON.stringify(chunk({ content: "answer" }))}\n\ndata: ${JSON.stringify(chunk({}, "stop"))}\n\ndata: [DONE]\n\n`,
    { headers: { "content-type": "text/event-stream" } },
  );

it.each([false, true])(
  "recovers one pre-output 401 with a changed credential, repeated 401=%s",
  async (repeated) => {
    const keys: string[] = [];
    const getApiKey = vi.fn(async (rejected?: string) => (rejected ? "new-key" : "old-key"));
    const fetcher = vi.fn<typeof fetch>(async (_input, init) => {
      keys.push(new Headers(init?.headers).get("authorization") ?? "");
      return keys.length === 1 || repeated ? unauthorized() : success();
    });
    const stream = streamSimple(fakeModel("http://local/v1"), context, { getApiKey, fetch: fetcher });
    const types: string[] = [];
    for await (const event of stream) types.push(event.type);
    expect((await stream.result()).stopReason).toBe(repeated ? "error" : "stop");
    expect(keys).toEqual(["Bearer old-key", "Bearer new-key"]);
    expect(getApiKey.mock.calls).toEqual([[], ["old-key"]]);
    expect(types.filter((type) => type === "start")).toHaveLength(repeated ? 0 : 1);
  },
);

it.each([false, true])("does not replay a 401 with an unchanged API key, callback=%s", async (callback) => {
  const fetcher = vi.fn<typeof fetch>(async () => unauthorized());
  const getApiKey = vi.fn(async () => "fixed-key");
  const result = await streamSimple(fakeModel("http://local/v1"), context, {
    apiKey: "fixed-key",
    ...(callback ? { getApiKey } : {}),
    fetch: fetcher,
  }).result();
  expect(result.errorDetails?.status).toBe(401);
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(getApiKey).toHaveBeenCalledTimes(callback ? 2 : 0);
});

it("cancels a request while shared credential recovery continues without issuing a late request", async () => {
  const controller = new AbortController();
  const refresh = Promise.withResolvers<string>();
  const refreshing = Promise.withResolvers<void>();
  const getApiKey = vi.fn(async (rejected?: string) => {
    if (!rejected) return "old-key";
    refreshing.resolve();
    return refresh.promise;
  });
  const fetcher = vi.fn<typeof fetch>(async () => unauthorized());
  const stream = streamSimple(fakeModel("http://local/v1"), context, {
    getApiKey,
    fetch: fetcher,
    signal: controller.signal,
  });
  await refreshing.promise;
  controller.abort();
  expect((await stream.result()).stopReason).toBe("aborted");
  refresh.resolve("new-key");
  await new Promise((resolve) => setImmediate(resolve));
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it("does not refresh credentials after partial output", async () => {
  const getApiKey = vi.fn(async () => "key");
  const fetcher = vi.fn<typeof fetch>(
    async () =>
      new Response(
        [
          { type: "response.output_text.delta", item_id: "msg", content_index: 0, delta: "partial" },
          { type: "error", status: 401, code: "unauthorized", message: "Unauthorized" },
        ]
          .map((event) => `data: ${JSON.stringify(event)}\n\n`)
          .join(""),
        {
          headers: { "content-type": "text/event-stream" },
        },
      ),
  );
  const result = await streamSimple({ ...fakeModel("http://local/v1"), api: "openai-responses" }, context, {
    getApiKey,
    fetch: fetcher,
  }).result();
  expect(result.stopReason).toBe("error");
  expect(result.content).toMatchObject([{ text: "partial" }]);
  expect(getApiKey).toHaveBeenCalledTimes(1);
  expect(fetcher).toHaveBeenCalledTimes(1);
});
