import { afterEach, expect, it, vi } from "vitest";
import { withHttpIdleTimeout } from "../src/core/http-idle-timeout.ts";

afterEach(() => vi.useRealTimers());
it("times out stalled headers, and cancellation wins even for a transport ignoring abort", async () => {
  vi.useFakeTimers();
  const stalled = vi.fn(() => new Promise<Response>(() => {}));
  const request = withHttpIdleTimeout(stalled, 1000);
  const pending = request("http://local");
  const failed = expect(pending).rejects.toMatchObject({ cause: { code: "UND_ERR_HEADERS_TIMEOUT" } });
  await vi.advanceTimersByTimeAsync(1000);
  await failed;
  const controller = new AbortController();
  const cancelled = request("http://local", { signal: controller.signal });
  const stopped = expect(cancelled).rejects.toMatchObject({ name: "AbortError" });
  controller.abort();
  await stopped;
  expect(vi.getTimerCount()).toBe(0);
  expect(withHttpIdleTimeout(stalled, 0)).toBe(stalled);
});
it("resets body idle time on each received chunk and cancels stalled reads", async () => {
  vi.useFakeTimers();
  let producer: ReadableStreamDefaultController<Uint8Array> | undefined;
  const response = await withHttpIdleTimeout(
    async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            producer = controller;
          },
        }),
      ),
    1000,
  )("http://local");
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Missing body");
  const first = reader.read();
  await vi.advanceTimersByTimeAsync(900);
  producer?.enqueue(new Uint8Array([1]));
  expect(await first).toMatchObject({ value: new Uint8Array([1]) });
  const second = reader.read();
  const failed = expect(second).rejects.toMatchObject({ cause: { code: "UND_ERR_BODY_TIMEOUT" } });
  await vi.advanceTimersByTimeAsync(999);
  await vi.advanceTimersByTimeAsync(1);
  await failed;
  expect(vi.getTimerCount()).toBe(0);
});
