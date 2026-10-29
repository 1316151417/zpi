// Adapted from Pi (commit c20cb09772bf4e2590a316cb54514cef76df4293) Copyright (c) 2025 Mario Zechner. MIT license
import type { ModelRetryStatus } from "../types.ts";
import { modelFailure } from "./model-retry.ts";

const DEFAULT_MAX_RETRY_DELAY_MS = 60_000;

interface ProviderRetryOptions {
  maxRetries?: number;
  maxRetryDelayMs?: number;
  signal?: AbortSignal;
  onRetry?: (status: ModelRetryStatus | null) => void;
}

interface ProviderError extends Error {
  status: number | undefined;
  headers: Headers | undefined;
}

function isProviderError(error: unknown): error is ProviderError {
  if (!(error instanceof Error) || !("status" in error) || !("headers" in error)) return false;
  return (
    (error.status === undefined || typeof error.status === "number") &&
    (error.headers === undefined || error.headers instanceof Headers)
  );
}

function validateServerRetryDelayMs(
  delayMs: number,
  maxRetryDelayMs: number | undefined,
  error: ProviderError,
): number {
  const maxDelayMs = maxRetryDelayMs ?? DEFAULT_MAX_RETRY_DELAY_MS;
  if (delayMs > 2147483647 || (maxDelayMs > 0 && delayMs > maxDelayMs)) {
    throw new Error(
      `Server requested ${Math.ceil(delayMs / 1000)}s retry delay (max: ${Math.ceil(maxDelayMs / 1000)}s). ${error.message}`,
      { cause: error },
    );
  }
  return delayMs;
}

function getRetryDelayMs(
  error: ProviderError,
  retryIndex: number,
  maxRetryDelayMs: number | undefined,
  retryAfterMs: number | undefined,
): number {
  if (retryAfterMs !== undefined) return validateServerRetryDelayMs(retryAfterMs, maxRetryDelayMs, error);

  const exponentialDelay = Math.min(0.5 * 2 ** retryIndex, 8) * 1000;
  return exponentialDelay * (1 - Math.random() * 0.25);
}

function createAbortError(): Error {
  const error = new Error("Request aborted");
  error.name = "AbortError";
  return error;
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(createAbortError());
      return;
    }

    const onAbort = () => {
      clearTimeout(timeout);
      reject(createAbortError());
    };
    const timeout = setTimeout(
      () => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      },
      Math.max(0, ms),
    );
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Reproduce the retry behavior used by the OpenAI and Anthropic SDKs while making
 * their backoff sleep interruptible. Their built-in retry timers ignore the
 * request AbortSignal, so callers must invoke the SDK with `maxRetries: 0` and
 * wrap the request with this helper. Provider-requested delays above
 * `maxRetryDelayMs` fail immediately (60 seconds by default); set it to zero to
 * disable the limit.
 */
export async function retryProviderRequest<T>(
  request: () => Promise<T>,
  options: ProviderRetryOptions = {},
): Promise<T> {
  const maxRetries = options.maxRetries ?? 0;
  let retriesRemaining = maxRetries;
  let retrying = false;

  try {
    for (;;) {
      try {
        // Each retry is a fresh SDK request, so X-Stainless-Retry-Count remains zero.
        return await request();
      } catch (error) {
        if (options.signal?.aborted) throw createAbortError();
        if (retriesRemaining <= 0 || !isProviderError(error)) throw error;
        const failure = modelFailure(error);
        if (!(failure.retryable ?? error.status === undefined)) throw error;

        const retryIndex = maxRetries - retriesRemaining;
        retriesRemaining--;
        const retryDelayMs = getRetryDelayMs(
          error,
          retryIndex,
          options.maxRetryDelayMs,
          failure.retryAfterMs,
        );
        retrying = true;
        options.onRetry?.({
          attempt: retryIndex + 1,
          maxRetries,
          retryDelayMs,
          errorStatus: error.status ?? null,
        });
        await abortableSleep(retryDelayMs, options.signal);
      }
    }
  } finally {
    if (retrying) options.onRetry?.(null);
  }
}
