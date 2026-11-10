import type { AssistantMessage, Model, ModelPerformanceSample } from "@zpi-dev/ai";

export interface ModelPerformance {
  turns?: number;
  steps?: number;
  llmMs?: number;
  toolMs?: number;
  ttftMs?: number;
  tokensPerSecond?: number;
  requestTokensPerSecond?: number;
  speedSampleCount?: number;
  requestMs?: number;
  firstTextMs?: number;
  modelLabel?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  cacheHitRate?: number;
}

/** Committed task totals; model aggregates grow with configurations, never with request count or content. */
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
interface ModelMeasurements {
  label: string;
  latest: { requestMs?: number; ttftMs?: number; firstTextMs?: number; tokensPerSecond?: number };
  decodeMs: number;
  decodeTokens: number;
  sampleCount: number;
}
export type ModelPerformanceTotals = ReturnType<typeof emptyPerformanceTotals> & {
  turnsKnown?: false;
  measurements?: Record<string, ModelMeasurements>;
  lastMeasurement?: string;
};

/** Provider IDs also isolate distinct accounts/endpoints that expose the same model name. */
export function performanceScope(model: Model, reasoning = "off"): string {
  return JSON.stringify([
    model.provider,
    model.id,
    model.api,
    model.baseUrl,
    model.auth ?? "",
    reasoning,
    model.samplingParams?.service_tier ?? "default",
  ]);
}
const nonnegative = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0;
const positive = (n: number | undefined): n is number => n !== undefined && Number.isFinite(n) && n > 0;
const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);

function validMeasurements(value: unknown): boolean {
  if (!object(value)) return false;
  return Object.values(value).every((v) => {
    if (!object(v) || typeof v.label !== "string" || !object(v.latest)) return false;
    const latest = v.latest;
    return (
      ["requestMs", "ttftMs", "firstTextMs", "tokensPerSecond"].every(
        (key) => latest[key] === undefined || nonnegative(latest[key]),
      ) &&
      nonnegative(v.decodeMs) &&
      Number.isSafeInteger(v.decodeTokens) &&
      Number(v.decodeTokens) >= 0 &&
      Number.isSafeInteger(v.sampleCount) &&
      Number(v.sampleCount) >= 0
    );
  });
}

export function validPerformanceTotals(value: unknown): value is ModelPerformanceTotals {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const data = value as Record<string, unknown>;
  return (
    (data.turnsKnown === undefined || data.turnsKnown === false) &&
    (data.measurements === undefined || validMeasurements(data.measurements)) &&
    (data.lastMeasurement === undefined ||
      (typeof data.lastMeasurement === "string" &&
        object(data.measurements) &&
        Object.hasOwn(data.measurements, data.lastMeasurement))) &&
    Object.keys(emptyPerformanceTotals()).every(
      (key) =>
        typeof data[key] === "number" &&
        Number.isFinite(data[key]) &&
        data[key] >= 0 &&
        (key.endsWith("Ms") || Number.isSafeInteger(data[key])),
    )
  );
}

export function modelPerformance(
  t: ModelPerformanceTotals,
  scope: string | null | undefined = t.lastMeasurement,
): ModelPerformance {
  const input = t.inputTokens + t.cacheReadTokens + t.cacheWriteTokens;
  const measurements = scope == null ? undefined : t.measurements?.[scope];
  return {
    ...(t.steps ? { ...(t.turnsKnown === false ? {} : { turns: t.turns }), steps: t.steps } : {}),
    ...(t.llmMs > 0 ? { llmMs: t.llmMs } : {}),
    ...(t.toolMs > 0 ? { toolMs: t.toolMs } : {}),
    ...(measurements
      ? {
          modelLabel: measurements.label,
          requestMs: measurements.latest.requestMs,
          ttftMs: measurements.latest.ttftMs,
          firstTextMs: measurements.latest.firstTextMs,
          requestTokensPerSecond: measurements.latest.tokensPerSecond,
          speedSampleCount: measurements.sampleCount,
          ...(measurements.sampleCount && measurements.decodeMs > 0
            ? {
                tokensPerSecond: (measurements.decodeTokens * 1000) / measurements.decodeMs,
              }
            : {}),
        }
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

/** Estimate text delivery only when usage describes that text and the receive window is sustained.
 * These sample-quality cutoffs are product policy, not a bound on possible model speed.
 */
function textSpeed(
  sample: ModelPerformanceSample,
  message: Pick<AssistantMessage, "usage" | "usageAvailable"> | undefined,
  model: Model,
  reasoning?: string,
) {
  if (
    !message?.usageAvailable ||
    !Number.isSafeInteger(message.usage.output) ||
    message.usage.output <= 0 ||
    sample.outputTokens !== message.usage.output ||
    sample.hasToolCalls ||
    !positive(sample.firstTextMs) ||
    !positive(sample.textGenerationMs) ||
    sample.textGenerationMs < 200 ||
    (sample.textChunks ?? 0) < 3 ||
    !positive(sample.textChars) ||
    !positive(sample.largestTextChunk) ||
    sample.largestTextChunk / sample.textChars > 0.8 ||
    !positive(sample.requestMs) ||
    sample.firstTextMs + sample.textGenerationMs > sample.requestMs ||
    sample.textGenerationMs / (sample.requestMs - sample.firstTextMs) < 0.25
  )
    return;
  const thinking = message.usage.reasoning;
  // Missing reasoning usage is unknown, including for gateways exposing familiar model names.
  if (thinking === undefined && (sample.hasThinking || (model.reasoning && reasoning !== "off"))) return;
  if (
    thinking !== undefined &&
    (!Number.isSafeInteger(thinking) || thinking < 0 || thinking > message.usage.output)
  )
    return;
  const tokens = message.usage.output - (thinking ?? 0);
  if (tokens < 20) return;
  return { tokens, ms: sample.textGenerationMs };
}

/** Publish settled requests; cumulative usage is global, delivery measurements belong to one model scope. */
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
    this.totals =
      initial && validPerformanceTotals(initial) ? structuredClone(initial) : emptyPerformanceTotals();
  }
  get value(): ModelPerformance {
    return modelPerformance(this.totals);
  }
  get snapshot(): ModelPerformanceTotals {
    return structuredClone(this.totals);
  }
  begin(): void {
    this.epoch++;
    this.countedTurn = false;
    this.tools.clear();
  }
  request(model?: Model, reasoning?: string) {
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
        if (success && sample) {
          if (positive(sample.requestMs)) this.totals.llmMs += sample.requestMs;
          if (model) {
            const scope = performanceScope(model, reasoning);
            this.totals.measurements ??= {};
            const groups = this.totals.measurements;
            groups[scope] ??= {
              label: model.name,
              latest: {},
              decodeMs: 0,
              decodeTokens: 0,
              sampleCount: 0,
            };
            const group = groups[scope];
            const speed = textSpeed(sample, message, model, reasoning);
            group.latest = {
              ...(positive(sample.requestMs) ? { requestMs: sample.requestMs } : {}),
              ...(positive(sample.ttftMs) ? { ttftMs: sample.ttftMs } : {}),
              ...(positive(sample.firstTextMs) ? { firstTextMs: sample.firstTextMs } : {}),
              ...(speed ? { tokensPerSecond: (speed.tokens * 1000) / speed.ms } : {}),
            };
            if (speed) {
              group.decodeMs += speed.ms;
              group.decodeTokens += speed.tokens;
              group.sampleCount++;
            }
            this.totals.lastMeasurement = scope;
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
