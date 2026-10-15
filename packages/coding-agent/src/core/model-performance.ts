import type { ModelPerformanceSample } from "zpi-ai";

export interface ModelPerformance {
  ttftMs?: number;
  tokensPerSecond?: number;
}

/** One interaction, constant space. In-flight samples are provisional until the request succeeds. */
export class InteractionPerformance {
  private totals = { ttft: 0, requests: 0, tokens: 0, duration: 0 };
  private current?: ModelPerformanceSample;
  private epoch = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private lastPublished = -Infinity;
  private changed: (value: ModelPerformance) => void;
  constructor(changed: (value: ModelPerformance) => void) {
    this.changed = changed;
  }

  get value(): ModelPerformance {
    const t = { ...this.totals };
    this.add(t, this.current);
    return {
      ...(t.requests ? { ttftMs: t.ttft / t.requests } : {}),
      ...(t.duration ? { tokensPerSecond: (t.tokens * 1000) / t.duration } : {}),
    };
  }
  reset(): void {
    this.epoch++;
    this.totals = { ttft: 0, requests: 0, tokens: 0, duration: 0 };
    this.current = undefined;
    this.flush();
  }
  request() {
    const epoch = ++this.epoch;
    this.current = undefined;
    let finished = false;
    return {
      update: (sample: ModelPerformanceSample) => {
        if (finished || epoch !== this.epoch) return;
        this.current = sample;
        const wait = Math.max(0, 750 - (performance.now() - this.lastPublished));
        if (!wait) this.flush();
        else this.timer ??= setTimeout(() => this.flush(), wait);
      },
      finish: (success: boolean) => {
        if (finished || epoch !== this.epoch) return;
        finished = true;
        if (success) this.add(this.totals, this.current);
        this.current = undefined;
        this.flush();
      },
    };
  }
  settle(): void {
    this.epoch++;
    this.current = undefined;
    this.flush();
  }
  dispose(): void {
    this.epoch++;
    clearTimeout(this.timer);
    this.timer = undefined;
  }
  private add(t: typeof this.totals, sample?: ModelPerformanceSample): void {
    const positive = (value: number | undefined): value is number =>
      value !== undefined && Number.isFinite(value) && value > 0;
    if (positive(sample?.ttftMs)) {
      t.ttft += sample.ttftMs;
      t.requests++;
    }
    if (positive(sample?.outputTokens) && positive(sample?.generationMs)) {
      t.tokens += sample.outputTokens;
      t.duration += sample.generationMs;
    }
  }
  private flush(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.lastPublished = performance.now();
    this.changed(this.value);
  }
}
