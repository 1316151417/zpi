// Adapted from ZCode lib/workDuration.ts, ai-elements/reasoning.tsx and
// v4/conversationTurnWorkSegments.ts (Apache-2.0).
// See THIRD_PARTY_NOTICES.md for provenance.
import type { RunView } from "../types.ts";

export function runPresentation(run: RunView) {
  const visible = run.orderedBlocks.filter((block) => block.type !== "thinking" || block.text.trim());
  const tail = visible.at(-1);
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
