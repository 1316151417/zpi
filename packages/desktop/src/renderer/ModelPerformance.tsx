import type { ModelPerformance as Performance } from "zpi-coding-agent";

export function performanceText(value?: Performance): string {
  const positive = (n: number | undefined): n is number => n !== undefined && Number.isFinite(n) && n > 0;
  const parts: string[] = [];
  if (positive(value?.tokensPerSecond)) {
    const speed = value.tokensPerSecond;
    parts.push(`${speed < 0.1 ? "<0.1" : speed < 10 ? speed.toFixed(1) : Math.round(speed)} tok/s`);
  }
  if (positive(value?.ttftMs))
    parts.push(`TTFT ${value.ttftMs < 100 ? "<0.1" : (value.ttftMs / 1000).toFixed(1)} s`);
  return parts.join(" · ");
}

export function ModelPerformance({ value }: { value?: Performance }) {
  const text = performanceText(value);
  return text ? (
    <div
      className="model-performance"
      data-testid="model-performance"
      title="本次交互的平均输出速度与平均首段内容等待时间"
    >
      {text}
    </div>
  ) : null;
}
