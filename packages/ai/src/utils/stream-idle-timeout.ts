// Adapted from ZCode 872ad960, adapters/model/stream-idle-timeout.ts (Apache-2.0).
// See licenses/third-party-notices.txt. Time model events, not HTTP bytes or SSE comments.
export const DEFAULT_MODEL_FIRST_RESPONSE_TIMEOUT_MS = 120_000;
export const DEFAULT_MODEL_STREAM_IDLE_TIMEOUT_MS = 300_000;

export function resolveModelStreamIdleTimeoutMs(options: {
  baseTimeoutMs?: number;
  retryNumber?: number;
}): number {
  const baseTimeoutMs =
    options.baseTimeoutMs === undefined || !Number.isFinite(options.baseTimeoutMs)
      ? DEFAULT_MODEL_STREAM_IDLE_TIMEOUT_MS
      : options.baseTimeoutMs;
  return baseTimeoutMs;
}

export class ModelRequestRetryError extends Error {
  readonly code = "MODEL_REQUEST_RETRY";
  constructor() {
    super("Model request retry requested");
    this.name = "ModelRequestRetryError";
  }
}

export class ModelRecoveryDeadlineError extends Error {
  readonly code = "MODEL_RECOVERY_DEADLINE";
  constructor() {
    super("Model recovery time limit exceeded; retry or select another model.");
    this.name = "ModelRecoveryDeadlineError";
  }
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
    startedAt?: number;
  },
): Promise<IteratorResult<T>> {
  const readStartedAt = options.startedAt ?? Date.now();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let removeAbortListener: (() => void) | undefined;
  let timeoutError: ModelStreamIdleTimeoutError | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    // Disabling the deadline must not disable Stop for an abort-ignoring provider.
    if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) return;
    timeout = setTimeout(
      () => {
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
      },
      Math.max(1, options.timeoutMs - (Date.now() - readStartedAt)),
    );
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
