// Adapted from ZCode lib/workDuration.ts and ai-elements/reasoning.tsx (Apache-2.0).
// See THIRD_PARTY_NOTICES.md for provenance.
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
