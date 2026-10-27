import type { DesktopEvent } from "zpi-ui";

export const streamingActivityIntervalMs = 5_000;

/** Content remains lossless; only the task-list activity clock is sampled. */
export function sessionActivityAt(event: DesktopEvent, previous: number, now: number): number | undefined {
  switch (event.type) {
    case "session_changed":
    case "controls_changed":
    case "model_performance":
    case "queue_changed":
    case "history_reset":
    case "question_changed":
      return undefined;
    case "started":
      return event.startedAt;
    case "settled":
      return event.endedAt;
    case "block_delta":
    case "tool_update":
      // 每个 token 都改变任务记录会使侧栏缓存失效；只降低活动时钟频率，不丢正文增量。
      return now >= previous && now - previous < streamingActivityIntervalMs ? undefined : now;
    default:
      return now;
  }
}
