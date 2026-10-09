/** Pi's header/body idle timeout, adapted for both Node fetch and Electron net.fetch. */
export function withHttpIdleTimeout(requestFetch: typeof fetch, timeoutMs: number): typeof fetch {
  if (timeoutMs === 0) return requestFetch;
  return async (input, init) => {
    const parent = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    const controller = new AbortController();
    const abort = () => controller.abort(parent?.reason);
    parent?.addEventListener("abort", abort, { once: true });
    if (parent?.aborted) abort();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      clearTimeout(timer);
      parent?.removeEventListener("abort", abort);
    };
    const timed = async <T>(operation: () => Promise<T>, phase: "headers" | "body"): Promise<T> => {
      controller.signal.throwIfAborted();
      let onAbort: (() => void) | undefined;
      const cancelled = new Promise<never>((_, reject) => {
        onAbort = () => reject(controller.signal.reason ?? new DOMException("Request aborted", "AbortError"));
        controller.signal.addEventListener("abort", onAbort, { once: true });
      });
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          const error = new TypeError("fetch failed", {
            cause: Object.assign(new Error(`${phase} timeout`), {
              code: phase === "headers" ? "UND_ERR_HEADERS_TIMEOUT" : "UND_ERR_BODY_TIMEOUT",
            }),
          });
          controller.abort(error);
          reject(error);
        }, timeoutMs);
      });
      try {
        return await Promise.race([operation(), timeout, cancelled]);
      } finally {
        clearTimeout(timer);
        if (onAbort) controller.signal.removeEventListener("abort", onAbort);
      }
    };
    try {
      const response = await timed(
        () => requestFetch(input, { ...init, signal: controller.signal }),
        "headers",
      );
      if (!response.body) {
        cleanup();
        return response;
      }
      const reader = response.body.getReader();
      const body = new ReadableStream<Uint8Array>({
        async pull(stream) {
          try {
            const next = await timed(() => reader.read(), "body");
            if (next.done) {
              cleanup();
              stream.close();
            } else stream.enqueue(next.value);
          } catch (error) {
            cleanup();
            stream.error(error);
            void reader.cancel(error).catch(() => {});
          }
        },
        async cancel(reason) {
          cleanup();
          controller.abort(reason);
          await reader.cancel(reason);
        },
      });
      const wrapped = new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
      Object.defineProperty(wrapped, "url", { value: response.url });
      return wrapped;
    } catch (error) {
      cleanup();
      throw error;
    }
  };
}
