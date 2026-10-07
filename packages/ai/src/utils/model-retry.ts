// Adapted from ZCode retry-policy.ts, runner-retry.ts, failure-classifier.ts and
// stream-retry-boundary.ts (Apache-2.0). See THIRD_PARTY_NOTICES.md.
import type { AssistantMessageEvent, ModelFailure, StreamOptions } from "../types.ts";
import type { AssistantMessageEventStream } from "./event-stream.ts";

const TERMINAL_CODES = new Set([
  "1005",
  "1006",
  "1008",
  "1113",
  "1261",
  "1304",
  "1308",
  "1309",
  "1310",
  "1311",
  "1313",
  "1314",
  "1315",
  "1316",
  "1317",
  "1318",
  "1319",
  "1320",
  "1321",
  "20097",
  "2056",
  "3001",
  "3006",
  "3007",
  "3008",
  "3009",
  "3010",
  "insufficient_quota",
  "credit_balance_exhausted",
  "organization_spend_limit_exceeded",
  "project_spend_limit_exceeded",
  "organization_usage_limit_exceeded",
  "exceeded_current_quota_error",
]);
const TRANSIENT_CODES = new Set([
  "500",
  "1120",
  "1230",
  "1234",
  "1302",
  "1303",
  "1305",
  "1312",
  "2007",
  "3002",
  "rate_limit_reached_error",
  "rate_limit_error",
  "engine_overloaded_error",
  "overloaded_error",
  "network_error",
  "network_error_retryable",
  "ECONNRESET",
  "ECONNREFUSED",
  "EAI_AGAIN",
  "ENOTFOUND",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "UND_ERR_SOCKET",
  "ETIMEDOUT",
  "ETIMEOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
]);

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

/** Preserve retry facts before provider errors are converted into transcript text. */
export function modelFailure(error: unknown, signal?: AbortSignal): ModelFailure {
  const seen = new Set<unknown>();
  const records: Record<string, unknown>[] = [];
  for (let current = error; current && !seen.has(current); current = record(current).cause) {
    seen.add(current);
    records.push(record(current));
  }
  const status = records.map((r) => r.status ?? r.statusCode).find((v) => typeof v === "number") as
    | number
    | undefined;
  const headersValue = records.map((r) => r.headers ?? r.responseHeaders).find((v) => v != null);
  const headers =
    headersValue instanceof Headers
      ? headersValue
      : new Headers(
          Object.entries(record(headersValue)).filter(
            (entry): entry is [string, string] => typeof entry[1] === "string",
          ),
        );
  const shouldRetry = headers.get("x-should-retry")?.trim().toLowerCase();
  let retryAfterMs: number | undefined;
  if (shouldRetry !== "false" && shouldRetry !== "0") {
    const ms = headers.get("retry-after-ms");
    const after = headers.get("retry-after");
    if (ms?.trim() && Number.isFinite(Number(ms))) retryAfterMs = Math.max(0, Math.round(Number(ms)));
    else if (after?.trim()) {
      const delay = Number.isFinite(Number(after)) ? Number(after) * 1000 : Date.parse(after) - Date.now();
      if (Number.isFinite(delay)) retryAfterMs = Math.max(0, Math.round(delay));
    }
  }
  const codes = records.flatMap((r) => {
    const body = record(r.error);
    return [r.code, body.code, body.type].flatMap((v) =>
      typeof v === "string" || typeof v === "number" ? [String(v)] : [],
    );
  });
  const aborted = signal?.aborted || records.some((r) => r.name === "AbortError" || r.code === "ABORT_ERR");
  const terminal = codes.some((code) => TERMINAL_CODES.has(code) || /CERT|TLS|SSL/iu.test(code));
  const retryable =
    !aborted &&
    !terminal &&
    (codes.some((code) => TRANSIENT_CODES.has(code) || code.toUpperCase().includes("PROXY")) ||
      status === 408 ||
      status === 429 ||
      (status !== undefined && status >= 500) ||
      records.some(
        (r) =>
          r.isRetryable === true ||
          r.name === "APIConnectionError" ||
          r.name === "APIConnectionTimeoutError" ||
          r.name === "TimeoutError" ||
          r.name === "timeout_error" ||
          (record(r.error).type === "api_error" &&
            ["500 internal network error", "internal network error", "internal network failure"].includes(
              String(record(r.error).message ?? r.message ?? "")
                .trim()
                .toLowerCase(),
            )) ||
          (typeof r.message === "string" && /^Stream ended without /u.test(r.message)),
      ) ||
      (status === 409 && shouldRetry !== "false") ||
      (status === undefined && shouldRetry === "true"));
  return {
    retryable,
    ...(status !== undefined ? { status } : {}),
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
  };
}

export function modelRetryDelay(attempt: number, retryAfterMs?: number, maxDelayMs = 60_000): number {
  const exponential = 2_000 * 2 ** Math.max(0, attempt - 1);
  if (
    retryAfterMs !== undefined &&
    Number.isFinite(retryAfterMs) &&
    retryAfterMs >= 0 &&
    (retryAfterMs <= 300_000 || retryAfterMs < exponential)
  )
    return retryAfterMs;
  return Math.round(Math.min(exponential, Math.max(0, maxDelayMs)) * (0.5 + Math.random() * 0.5));
}

export function sleepForModelRetry(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(new DOMException("Request aborted", "AbortError"));
    };
    const timer = setTimeout(
      () => {
        signal?.removeEventListener("abort", abort);
        resolve();
      },
      Math.max(0, ms),
    );
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
  });
}

/** Retry the whole stream before its first visible token or complete tool call. */
export async function retryModelStream(
  consume: (sink: Pick<AssistantMessageEventStream, "push">) => Promise<void>,
  events: AssistantMessageEventStream,
  options: StreamOptions,
): Promise<void> {
  const maxRetries =
    options.maxRetries !== undefined && Number.isFinite(options.maxRetries)
      ? Math.max(0, Math.floor(options.maxRetries))
      : 10;
  let committed = false;
  let emptyRetries = 0;
  try {
    for (let attempt = 0; ; attempt++) {
      const prelude: AssistantMessageEvent[] = [];
      try {
        options.signal?.throwIfAborted();
        await consume({
          push(event) {
            if (
              event.type === "done" &&
              !committed &&
              !event.message.content.some(
                (c) => c.type === "toolCall" || (c.type === "text" && c.text.length > 0),
              ) &&
              event.message.usage.totalTokens === 0
            ) {
              const canRetry = emptyRetries < 1 && attempt < maxRetries;
              emptyRetries++;
              throw Object.assign(
                new Error("Model returned no text, no tool calls, and no usage before completing the turn."),
                { isRetryable: canRetry },
              );
            }
            const boundary =
              event.type === "done" ||
              event.type === "toolcall_end" ||
              ((event.type === "text_delta" || event.type === "thinking_delta") && event.delta.length > 0);
            if (!committed && !boundary) {
              prelude.push(event);
              return;
            }
            if (!committed) {
              committed = true;
              options.onRetry?.(null);
              for (const buffered of prelude) events.push(buffered);
            }
            events.push(event);
          },
        });
        return;
      } catch (error) {
        const failure = modelFailure(error, options.signal);
        if (committed || !failure.retryable || attempt >= maxRetries) throw error;
        const retryDelayMs = modelRetryDelay(attempt + 1, failure.retryAfterMs, options.maxRetryDelayMs);
        options.onRetry?.({
          attempt: attempt + 1,
          maxRetries,
          retryDelayMs,
          errorStatus: failure.status ?? null,
        });
        await sleepForModelRetry(retryDelayMs, options.signal);
      }
    }
  } finally {
    options.onRetry?.(null);
  }
}
