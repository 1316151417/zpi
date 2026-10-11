import { afterEach, expect, it, vi } from "vitest";
import { normalizeContext } from "zpi-ai";
import { streamSimple } from "zpi-ai/api/openai-completions";
import { chunk, done, fakeModel, fakeServer, send } from "../../../tests/fake-server.ts";
import { retryProviderRequest } from "../src/utils/provider-retry.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await Promise.all(cleanup.splice(0).map((close) => close()));
});

it("retries HTTP 429 and 5xx before streaming, respects headers and never repeats partial output", async () => {
  let mode: "retry" | "bad" | "partial" = "retry";
  const server = await fakeServer((_, response, index) => {
    if (mode === "retry" && index < 2) {
      response.writeHead(index === 0 ? 429 : 503, {
        "content-type": "application/json",
        ...(index === 0 ? { "retry-after": "0.01" } : {}),
      });
      response.end(JSON.stringify({ error: { message: "try later" } }));
    } else if (mode === "bad") {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "bad input" } }));
    } else {
      send(response, chunk({ content: "once" }));
      if (mode === "partial") response.end();
      else done(response);
    }
  });
  cleanup.push(server.close);
  const request = () =>
    streamSimple(fakeModel(server.url), normalizeContext({ messages: [] }), { apiKey: "local" });
  const start = Date.now();
  const stream = request();
  const types: string[] = [];
  for await (const event of stream) types.push(event.type);
  expect((await stream.result()).stopReason).toBe("stop");
  expect(server.requests).toHaveLength(3);
  expect(types.filter((type) => type === "start")).toHaveLength(1);
  expect(Date.now() - start).toBeGreaterThanOrEqual(750);
  mode = "bad";
  expect((await request().result()).stopReason).toBe("error");
  expect(server.requests).toHaveLength(4);
  mode = "partial";
  const partial = await request().result();
  expect(partial.stopReason).toBe("error");
  expect(partial.content).toEqual([{ type: "text", text: "once" }]);
  expect(server.requests).toHaveLength(5);
});

it("uses server retry policy, bounded delay and interruptible backoff", async () => {
  vi.useFakeTimers();
  const error = (status: number | undefined, headers: Record<string, string> = {}) =>
    Object.assign(new Error("provider unavailable"), { status, headers: new Headers(headers) });
  const request = vi
    .fn()
    .mockRejectedValueOnce(
      error(400, { "x-should-retry": "true", "retry-after-ms": "100", "retry-after": "10" }),
    )
    .mockResolvedValue("ok");
  const result = retryProviderRequest(request, { maxRetries: 2 });
  await vi.advanceTimersByTimeAsync(99);
  expect(request).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(await result).toBe("ok");

  const controller = new AbortController();
  const waiting = vi.fn().mockRejectedValue(error(undefined));
  const aborted = retryProviderRequest(waiting, { maxRetries: 2, signal: controller.signal });
  const assertion = expect(aborted).rejects.toMatchObject({ name: "AbortError" });
  await vi.advanceTimersByTimeAsync(1);
  controller.abort();
  await assertion;
  expect(waiting).toHaveBeenCalledTimes(1);

  const limited = vi.fn().mockRejectedValue(error(429, { "retry-after": "61" }));
  await expect(retryProviderRequest(limited, { maxRetries: 2 })).rejects.toThrow("max: 60s");
  expect(limited).toHaveBeenCalledTimes(1);
  const forbidden = vi.fn().mockRejectedValue(error(503, { "x-should-retry": "false" }));
  await expect(retryProviderRequest(forbidden, { maxRetries: 2 })).rejects.toThrow("provider unavailable");
  expect(forbidden).toHaveBeenCalledTimes(1);
});
