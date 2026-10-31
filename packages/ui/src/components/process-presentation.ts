// Adapted from ZCode lib/workDuration.ts, ai-elements/reasoning.tsx and
// v4/conversationTurnWorkSegments.ts (Apache-2.0).
// See licenses/third-party-notices.txt for provenance.
import type { RunView, ViewBlock } from "../types.ts";

export function runPresentation(run: RunView) {
  const merged: (ViewBlock & { lastBlockId?: string })[] = [];
  const boundaries = new Set(run.compactions?.map((marker) => marker.afterBlockId));
  for (const block of run.orderedBlocks) {
    const previous = merged.at(-1);
    if (
      block.type === "thinking" &&
      previous?.type === "thinking" &&
      previous.messageId === block.messageId &&
      !boundaries.has(previous.lastBlockId ?? previous.id)
    ) {
      // 只合并展示副本，保留首项身份和整段耗时；原始条目仍参与存储和协议回放。
      const streaming = Boolean(previous.streaming || block.streaming);
      merged[merged.length - 1] = {
        ...previous,
        text: [previous.text, block.text].filter((text) => text.trim()).join("\n\n"),
        streaming,
        interrupted: Boolean(previous.interrupted || block.interrupted),
        endedAt: streaming ? undefined : block.endedAt,
        lastBlockId: block.id,
      };
    } else merged.push(block);
  }
  const visible = merged.filter((block) => block.type === "tool" || block.text.trim());
  // 后续通知可能只生成思考；它仍属于工作过程，不能挡住已有的最终正文。
  const tail = visible.findLast((block) => block.type !== "thinking");
  // ZCode 运行中把正文和思考、工具按原序放在工作区；终态只把末段正文移到折叠区外。
  // 不能按 finalAnswerBlockIds 提前抽走全部正文，否则工具开始后正文会跳位，早期段落也会外露。
  const answer =
    run.status !== "running" && tail?.type === "text" && run.finalAnswerBlockIds.includes(tail.id)
      ? tail
      : undefined;
  return {
    process: visible.filter((block) => block !== answer),
    answer,
    defaultOpen: run.status !== "completed" || (!answer && visible.length > 0),
  };
}

export function workDuration(durationMs: number): string {
  const totalSeconds = Math.max(1, Math.round(durationMs / 1000));
  const parts = [
    { value: Math.floor(totalSeconds / 86_400), unit: "天" },
    { value: Math.floor((totalSeconds % 86_400) / 3_600), unit: "时" },
    { value: Math.floor((totalSeconds % 3_600) / 60), unit: "分" },
    { value: totalSeconds % 60, unit: "秒" },
  ].filter((part) => part.value > 0);
  return parts
    .slice(0, 2)
    .map((part) => `${part.value} ${part.unit}`)
    .join(" ");
}

export function reasoningSummary(text: string): string {
  const lines = text.replace(/\r\n?/gu, "\n").split("\n");
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index]?.trim();
    if (line) return line;
  }
  return "";
}

export function reasoningDuration(durationMs?: number): string {
  // ZCode 思考耗时始终向上取整为秒；历史缺少耗时时仍显示完整状态文案。
  return durationMs === undefined ? "持续了几秒" : `持续了 ${Math.max(1, Math.ceil(durationMs / 1000))} 秒`;
}
