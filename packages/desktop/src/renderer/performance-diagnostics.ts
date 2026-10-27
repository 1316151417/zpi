import { performanceReportIntervalMs, SlowOperations } from "../shared/performance-diagnostics.ts";
import { logRendererError } from "./error-log.ts";

let operations: SlowOperations | undefined;

export function recordEventBatch(durationMs: number, eventCount: number): void {
  if (document.visibilityState === "visible") operations?.record("event-batch", durationMs, eventCount);
}

export function startRendererPerformanceDiagnostics(): () => void {
  const samples = new SlowOperations();
  operations = samples;
  let visibleSince = performance.now();
  const visibility = () => {
    visibleSince = performance.now();
  };
  document.addEventListener("visibilitychange", visibility);
  let observer: PerformanceObserver | undefined;
  try {
    if (
      typeof PerformanceObserver !== "undefined" &&
      PerformanceObserver.supportedEntryTypes.includes("longtask")
    ) {
      observer = new PerformanceObserver((list) => {
        if (document.visibilityState !== "visible") return;
        for (const entry of list.getEntries())
          if (entry.startTime >= visibleSince) samples.record("long-task", entry.duration);
      });
      observer.observe({ type: "longtask" });
    }
  } catch {
    observer?.disconnect();
    // Diagnostics must not prevent an otherwise usable renderer from starting.
  }
  const flush = () => {
    for (const summary of samples.drain()) logRendererError("performance", JSON.stringify(summary));
  };
  const timer = setInterval(flush, performanceReportIntervalMs);
  return () => {
    clearInterval(timer);
    observer?.disconnect();
    document.removeEventListener("visibilitychange", visibility);
    if (operations === samples) operations = undefined;
    flush();
  };
}
