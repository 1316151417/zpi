export const performanceReportIntervalMs = 10_000;
const thresholds = { "long-task": 200, "event-batch": 50, "main-loop": 250 } as const;
export type SlowOperation = keyof typeof thresholds;
export interface SlowOperationSummary {
  operation: SlowOperation;
  count: number;
  maxMs: number;
  totalMs: number;
  eventCount: number;
}

/** Fixed-size numeric summaries, with no session content or per-event history. */
export class SlowOperations {
  private summaries = new Map<SlowOperation, SlowOperationSummary>();

  record(operation: SlowOperation, durationMs: number, eventCount = 0): void {
    if (!Number.isFinite(durationMs) || durationMs < thresholds[operation]) return;
    const summary = this.summaries.get(operation) ?? {
      operation,
      count: 0,
      maxMs: 0,
      totalMs: 0,
      eventCount: 0,
    };
    summary.count++;
    summary.maxMs = Math.max(summary.maxMs, durationMs);
    summary.totalMs += durationMs;
    if (Number.isSafeInteger(eventCount) && eventCount > 0) summary.eventCount += eventCount;
    this.summaries.set(operation, summary);
  }

  drain(): SlowOperationSummary[] {
    const summaries = [...this.summaries.values()].map((summary) => ({
      ...summary,
      maxMs: Math.round(summary.maxMs),
      totalMs: Math.round(summary.totalMs),
    }));
    this.summaries.clear();
    return summaries;
  }
}
