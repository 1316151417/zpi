// Adapted from ZCode 872ad960, adapters/model/stream-idle-timeout.ts (Apache-2.0).
// See THIRD_PARTY_NOTICES.md. Time model events, not HTTP bytes or SSE comments.
export const DEFAULT_MODEL_STREAM_IDLE_TIMEOUT_MS = 600_000;
const MODEL_STREAM_IDLE_TIMEOUT_RETRY_INCREMENT_MS = 30_000;

export function resolveModelStreamIdleTimeoutMs(options: {
  baseTimeoutMs?: number;
  retryNumber?: number;
}): number {
  const baseTimeoutMs =
    options.baseTimeoutMs === undefined || !Number.isFinite(options.baseTimeoutMs)
      ? DEFAULT_MODEL_STREAM_IDLE_TIMEOUT_MS
      : options.baseTimeoutMs;
  if (baseTimeoutMs <= 0) return baseTimeoutMs;
  const retryNumber =
    options.retryNumber === undefined || !Number.isFinite(options.retryNumber)
      ? 0
      : Math.max(0, Math.floor(options.retryNumber));
  return baseTimeoutMs + retryNumber * MODEL_STREAM_IDLE_TIMEOUT_RETRY_INCREMENT_MS;
}

export class ModelStreamIdleTimeoutError extends Error {
  readonly code = "MODEL_STREAM_IDLE_TIMEOUT";
  readonly idleMs: number;
  readonly timeoutMs: number;
  constructor(options: { idleMs: number; timeoutMs: number }) {
    super(`Model stream stalled: no event received for ${options.timeoutMs}ms.`);
    this.name = "ModelStreamIdleTimeoutError";
    this.idleMs = options.idleMs;
    this.timeoutMs = options.timeoutMs;
  }
}

export function createLinkedAbortController(parentSignal?: AbortSignal) {
  const controller = new AbortController();
  const abortFromParent = () => {
    if (!controller.signal.aborted) controller.abort(parentSignal?.reason);
  };
  if (parentSignal?.aborted) abortFromParent();
  else parentSignal?.addEventListener("abort", abortFromParent, { once: true });
  return {
    controller,
    signal: controller.signal,
    cleanup() {
      parentSignal?.removeEventListener("abort", abortFromParent);
    },
  };
}

export async function readNextWithStreamIdleTimeout<T>(
  iterator: AsyncIterator<T>,
  options: {
    abortController: AbortController;
    onTimeout?: (error: ModelStreamIdleTimeoutError) => void | Promise<void>;
    timeoutMs: number;
  },
): Promise<IteratorResult<T>> {
  const readStartedAt = Date.now();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let removeAbortListener: (() => void) | undefined;
  let timeoutError: ModelStreamIdleTimeoutError | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    // Disabling the deadline must not disable Stop for an abort-ignoring provider.
    if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) return;
    timeout = setTimeout(() => {
      if (options.abortController.signal.aborted) {
        reject(options.abortController.signal.reason ?? new Error("Model stream aborted."));
        return;
      }
      timeoutError = new ModelStreamIdleTimeoutError({
        idleMs: Math.max(0, Date.now() - readStartedAt),
        timeoutMs: options.timeoutMs,
      });
      options.abortController.abort(timeoutError);
      reject(timeoutError);
    }, options.timeoutMs);
  });
  const abortPromise = new Promise<never>((_, reject) => {
    const signal = options.abortController.signal;
    const rejectAbort = () => reject(signal.reason ?? new Error("Model stream aborted."));
    if (signal.aborted) {
      rejectAbort();
      return;
    }
    signal.addEventListener("abort", rejectAbort, { once: true });
    removeAbortListener = () => signal.removeEventListener("abort", rejectAbort);
  });
  try {
    return await Promise.race([iterator.next(), timeoutPromise, abortPromise]);
  } catch (error) {
    if (!timeoutError) throw error;
    await options.onTimeout?.(timeoutError);
    throw timeoutError;
  } finally {
    clearTimeout(timeout);
    removeAbortListener?.();
  }
}

/** A provider can ignore abort and hang in return(); cleanup must not block recovery. */
export async function closeStreamIterator(iterator: AsyncIterator<unknown> | undefined): Promise<void> {
  if (!iterator?.return) return;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.resolve()
        .then(() => iterator.return?.())
        .catch(() => {}),
      new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, 1_000);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}
