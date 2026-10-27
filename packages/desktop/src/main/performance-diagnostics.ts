import type { WebContents } from "electron";
import { performanceReportIntervalMs, SlowOperations } from "../shared/performance-diagnostics.ts";
import type { ErrorLog } from "./error-log.ts";

export function startMainPerformanceDiagnostics(log: ErrorLog, now = () => performance.now()) {
  const samples = new SlowOperations();
  let previous = now();
  let lastReport = previous;
  let suspended = false;
  const flush = () => {
    for (const summary of samples.drain()) log.write("main.performance", "Slow event loop", { ...summary });
  };
  const timer = setInterval(() => {
    if (suspended) return;
    const time = now();
    samples.record("main-loop", time - previous - 1_000);
    previous = time;
    if (time - lastReport >= performanceReportIntervalMs) {
      lastReport = time;
      flush();
    }
  }, 1_000);
  timer.unref();
  return {
    suspend() {
      suspended = true;
    },
    resume() {
      // 使用系统休眠事件重置时钟，不能靠时长猜测，否则会漏掉真正超过一分钟的阻塞。
      previous = now();
      lastReport = previous;
      suspended = false;
    },
    stop() {
      clearInterval(timer);
      flush();
    },
  };
}

export function trackRendererResponsiveness(contents: WebContents, log: ErrorLog): void {
  let stalledAt: number | undefined;
  contents.on("unresponsive", () => {
    if (stalledAt !== undefined) return;
    stalledAt = performance.now();
    log.write("renderer.unresponsive", "Renderer stopped responding", { webContentsId: contents.id });
  });
  contents.on("responsive", () => {
    if (stalledAt === undefined) return;
    log.write("renderer.responsive", "Renderer recovered", {
      webContentsId: contents.id,
      durationMs: Math.round(performance.now() - stalledAt),
    });
    stalledAt = undefined;
  });
}
