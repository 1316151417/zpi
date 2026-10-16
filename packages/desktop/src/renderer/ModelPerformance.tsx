import * as Menu from "@radix-ui/react-dropdown-menu";
import { Database, Gauge } from "lucide-react";
import { Fragment, type ReactNode } from "react";
import type { ModelPerformance as Performance } from "zpi-coding-agent";

const positive = (n: number | undefined): n is number => n !== undefined && Number.isFinite(n) && n > 0;
export function formatSpeed(n: number): string {
  return `${n < 0.1 ? "<0.1" : n < 10 ? Math.round(n * 10) / 10 : Math.round(n)} tok/s`;
}
export function formatDuration(ms: number): string {
  if (ms < 100) return "<0.1秒";
  if (ms < 60_000) return `${Math.round(ms / 100) / 10}秒`;
  const seconds = Math.round(ms / 1000);
  return `${Math.floor(seconds / 60)}分${seconds % 60}秒`;
}
export function formatTokens(n: number): string {
  const scale = (v: number) => (v >= 100 ? Math.round(v) : Math.round(v * 10) / 10);
  return n < 1000 ? String(n) : n < 1_000_000 ? `${scale(n / 1000)}K` : `${scale(n / 1_000_000)}M`;
}
export function formatCacheRate(rate: number): string {
  if (rate === 1) return "100%";
  for (let precision = 0; precision <= 12; precision++) {
    const rounded = Number((rate * 100).toFixed(precision));
    if (rounded < 100) return `${rounded}%`;
  }
  return "<100%";
}
function StatPill({
  icon,
  label,
  title,
  total,
  rows,
}: {
  icon: ReactNode;
  label: ReactNode;
  title: string;
  total?: string;
  rows: [string, string][];
}) {
  const content = (
    <>
      {icon}
      <span className="model-stat-label">{label}</span>
    </>
  );
  if (!rows.length) return <span className="model-stat-pill">{content}</span>;
  return (
    <Menu.Root modal={false}>
      <Menu.Trigger asChild>
        <button type="button" className="model-stat-pill" aria-label={title}>
          {content}
        </button>
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Content
          className="model-stat-dialog"
          side="top"
          align="center"
          sideOffset={8}
          collisionPadding={12}
          role="dialog"
          aria-label={title}
        >
          <div className="model-stat-title">
            <span>
              {icon}
              {title}
            </span>
            {total && <span>{total}</span>}
          </div>
          <dl>
            {rows.map(([name, value]) => (
              <Fragment key={name}>
                <dt>{name}</dt>
                <dd>{value}</dd>
              </Fragment>
            ))}
          </dl>
        </Menu.Content>
      </Menu.Portal>
    </Menu.Root>
  );
}
const joined = (a: string, b?: string) => (
  <>
    {a}
    {b && (
      <>
        <span className="model-stat-separator">·</span>
        {b}
      </>
    )}
  </>
);
export function ModelPerformance({ value }: { value?: Performance }) {
  if (!value) return null;
  const speed = positive(value.tokensPerSecond) ? formatSpeed(value.tokensPerSecond) : undefined;
  const activity: [string, string][] = [["步数", String(value.steps ?? 0)]];
  if (value.turns !== undefined) activity.unshift(["轮数", String(value.turns)]);
  if (positive(value.llmMs)) activity.push(["模型用时", formatDuration(value.llmMs)]);
  if (positive(value.toolMs)) activity.push(["工具调用用时", formatDuration(value.toolMs)]);
  if (positive(value.ttftMs)) activity.push(["首 token 平均（TTFT）", formatDuration(value.ttftMs)]);
  if (speed) activity.push(["输出速度（TPS）", speed]);
  const total =
    (value.inputTokens ?? 0) +
    (value.outputTokens ?? 0) +
    (value.cacheReadTokens ?? 0) +
    (value.cacheWriteTokens ?? 0);
  const cache =
    value.cacheHitRate !== undefined &&
    Number.isFinite(value.cacheHitRate) &&
    value.cacheHitRate >= 0 &&
    value.cacheHitRate <= 1
      ? formatCacheRate(value.cacheHitRate)
      : undefined;
  const exact = (n: number) => `${n.toLocaleString("en-US")} tok`;
  const usage: [string, string][] = [];
  if (cache) usage.push(["缓存命中", cache]);
  if (value.inputTokens !== undefined) usage.push(["未缓存输入", exact(value.inputTokens)]);
  if (value.cacheReadTokens !== undefined) usage.push(["缓存读取", exact(value.cacheReadTokens)]);
  if (positive(value.cacheWriteTokens)) usage.push(["缓存写入", exact(value.cacheWriteTokens)]);
  if (value.outputTokens !== undefined) usage.push(["输出", exact(value.outputTokens)]);
  if (!positive(value.steps) && !positive(total)) return null;
  return (
    <div className="model-performance" data-testid="model-performance">
      {positive(value.steps) && (
        <StatPill
          icon={<Gauge aria-hidden="true" />}
          title="会话统计"
          label={joined(`${value.turns === undefined ? "" : `${value.turns} 轮 `}${value.steps} 步`, speed)}
          rows={activity}
        />
      )}
      {positive(total) && (
        <StatPill
          icon={<Database aria-hidden="true" />}
          title="Token 用量"
          label={joined(`${formatTokens(total)} tok`, cache ? `缓存命中 ${cache}` : undefined)}
          total={exact(total)}
          rows={usage}
        />
      )}
    </div>
  );
}
