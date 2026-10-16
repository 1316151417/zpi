import type { AssistantMessage, ModelPerformanceSample } from "zpi-ai";

export interface ModelPerformance {
  turns?: number;
  steps?: number;
  llmMs?: number;
  toolMs?: number;
  ttftMs?: number;
  tokensPerSecond?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  cacheHitRate?: number;
}

/** Constant-size, committed task totals. No prompts or generated content are retained. */
export const emptyPerformanceTotals = () => ({
  turns: 0,
  steps: 0,
  llmMs: 0,
  toolMs: 0,
  ttftMs: 0,
  ttftCount: 0,
  decodeMs: 0,
  decodeTokens: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  usageCount: 0,
  cacheCount: 0,
});
export type ModelPerformanceTotals = ReturnType<typeof emptyPerformanceTotals> & { turnsKnown?: false };

export function validPerformanceTotals(value: unknown): value is ModelPerformanceTotals {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const data = value as Record<string, unknown>;
  return (
    (data.turnsKnown === undefined || data.turnsKnown === false) &&
    Object.keys(emptyPerformanceTotals()).every(
      (key) =>
        typeof data[key] === "number" &&
        Number.isFinite(data[key]) &&
        data[key] >= 0 &&
        (key.endsWith("Ms") || Number.isSafeInteger(data[key])),
    )
  );
}

export function modelPerformance(t: ModelPerformanceTotals): ModelPerformance {
  const input = t.inputTokens + t.cacheReadTokens + t.cacheWriteTokens;
  return {
    ...(t.steps ? { ...(t.turnsKnown === false ? {} : { turns: t.turns }), steps: t.steps } : {}),
    ...(t.llmMs > 0 ? { llmMs: t.llmMs } : {}),
    ...(t.toolMs > 0 ? { toolMs: t.toolMs } : {}),
    ...(t.ttftCount ? { ttftMs: t.ttftMs / t.ttftCount } : {}),
    ...(t.decodeMs > 0 && t.decodeTokens > 0
      ? { tokensPerSecond: (t.decodeTokens * 1000) / t.decodeMs }
      : {}),
    ...(t.usageCount
      ? {
          inputTokens: t.inputTokens,
          outputTokens: t.outputTokens,
          cacheReadTokens: t.cacheReadTokens,
          cacheWriteTokens: t.cacheWriteTokens,
        }
      : {}),
    ...(t.cacheCount && input > 0 ? { cacheHitRate: t.cacheReadTokens / input } : {}),
  };
}

/** Like the Harness dock, publish settled requests; keep prior readings while streaming. */
export class SessionPerformance {
  private totals: ModelPerformanceTotals;
  private epoch = 0;
  private countedTurn = false;
  private tools = new Map<string, number>();
  private changed: (value: ModelPerformance, totals: ModelPerformanceTotals) => void;
  constructor(
    changed: (value: ModelPerformance, totals: ModelPerformanceTotals) => void,
    initial?: ModelPerformanceTotals,
  ) {
    this.changed = changed;
    this.totals = initial && validPerformanceTotals(initial) ? { ...initial } : emptyPerformanceTotals();
  }
  get value(): ModelPerformance {
    return modelPerformance(this.totals);
  }
  get snapshot(): ModelPerformanceTotals {
    return { ...this.totals };
  }
  begin(): void {
    this.epoch++;
    this.countedTurn = false;
    this.tools.clear();
  }
  request() {
    const epoch = ++this.epoch;
    let sample: ModelPerformanceSample | undefined;
    let finished = false;
    return {
      update: (next: ModelPerformanceSample) => {
        if (!finished && epoch === this.epoch) sample = next;
      },
      finish: (
        success: boolean,
        message?: Pick<AssistantMessage, "usage" | "usageAvailable" | "cacheUsageAvailable">,
      ) => {
        if (finished || epoch !== this.epoch) return;
        finished = true;
        this.totals.steps++;
        if (!this.countedTurn) {
          this.totals.turns++;
          this.countedTurn = true;
        }
        const positive = (n: number | undefined): n is number =>
          n !== undefined && Number.isFinite(n) && n > 0;
        if (success && sample) {
          if (positive(sample.requestMs)) this.totals.llmMs += sample.requestMs;
          if (positive(sample.ttftMs)) {
            this.totals.ttftMs += sample.ttftMs;
            this.totals.ttftCount++;
          }
          // The dock's decode interval is first content to assembled response, excluding TTFT and tools.
          const decodeMs =
            positive(sample.requestMs) && positive(sample.ttftMs)
              ? sample.requestMs - sample.ttftMs
              : sample.generationMs;
          if (positive(sample.outputTokens) && positive(decodeMs)) {
            this.totals.decodeTokens += sample.outputTokens;
            this.totals.decodeMs += decodeMs;
          }
        }
        // Billed usage is separate from successful latency averages, including failed attempts with usage.
        if (message?.usageAvailable === true) {
          const u = message.usage;
          if (
            [u.input, u.output, u.cacheRead, u.cacheWrite].every((n) => Number.isSafeInteger(n) && n >= 0)
          ) {
            this.totals.inputTokens += u.input;
            this.totals.outputTokens += u.output;
            this.totals.cacheReadTokens += u.cacheRead;
            this.totals.cacheWriteTokens += u.cacheWrite;
            this.totals.usageCount++;
            if (message.cacheUsageAvailable) this.totals.cacheCount++;
          }
        }
        this.publish();
      },
    };
  }
  toolStart(id: string): void {
    this.tools.set(id, performance.now());
  }
  toolEnd(id: string): void {
    const start = this.tools.get(id);
    if (start === undefined) return;
    this.tools.delete(id);
    this.totals.toolMs += Math.max(0, performance.now() - start);
    this.publish();
  }
  settle(): void {
    this.epoch++;
    this.tools.clear();
  }
  dispose(): void {
    this.settle();
  }
  private publish(): void {
    this.changed(this.value, this.snapshot);
  }
}
