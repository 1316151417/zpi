import * as Menu from "@radix-ui/react-dropdown-menu";
import { Check, ChevronDown, ChevronRight } from "lucide-react";
import { useRef, useState } from "react";
import type { SessionView } from "zpi-ui";
import { availablePresets, defaultPreset, modelReasoningLabel } from "../shared/config.ts";
import { accept, refresh, report, unwrap, useStore } from "./store.ts";
export function SessionToolbar({
  view,
  open,
  onOpenChange,
  onSettings,
}: {
  view: SessionView;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSettings: () => void;
}) {
  const settings = useStore((s) => s.settings);
  const controls = view.controls;
  const chosen = controls?.selection;
  const provider = settings?.providers.find((p) => p.id === chosen?.provider);
  const configured = provider?.models.find((m) => m.id === chosen?.modelId);
  const mainMenu = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState<string>();
  const [updating, setUpdating] = useState(false);
  const select = (provider: string, modelId: string, reasoning: string, close = true) => {
    setUpdating(true);
    void window.zpi
      .setSessionSelection(view.sessionId, { provider, modelId, reasoning })
      .then(unwrap)
      .then(async (snapshot) => {
        accept(snapshot);
        await refresh();
        if (close) onOpenChange(false);
      })
      .catch(report)
      .finally(() => setUpdating(false));
  };
  const usage = controls?.usage,
    percent = usage?.percent;
  const breakdown = usage?.breakdown ?? [];
  const hasResponse = view.runs.some((run) => run.status !== "running" && run.orderedBlocks.length > 0);
  const totalChars = breakdown.reduce((sum, item) => sum + item.chars, 0);
  const labels = {
    messages: "消息",
    system_tools: "系统工具",
    system_prompt: "系统提示词",
    skills: "技能",
    other: "其他",
  };
  const compact = (number: number) =>
    new Intl.NumberFormat("zh-CN", { notation: "compact", maximumFractionDigits: 1 }).format(number);
  return (
    <div className="session-toolbar">
      {settings?.interface.showContextUsage && hasResponse && (
        <div className="context-indicator">
          <button
            className="context-circle"
            aria-label="上下文占用"
            aria-describedby={`context-${view.sessionId}`}
          >
            <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true">
              <circle className="context-track" cx="12" cy="12" r="9" />
              <circle
                className={`context-value ${percent == null ? "unknown" : ""}`}
                cx="12"
                cy="12"
                r="9"
                pathLength="100"
                strokeDasharray={`${percent == null ? 18 : Math.min(100, Math.max(0, percent))} 100`}
              />
            </svg>
          </button>
          <div className="context-tooltip" id={`context-${view.sessionId}`} role="tooltip">
            <div className="context-summary">
              <strong>上下文容量</strong>
              <span>
                {usage?.inputTokens == null ? "未知" : compact(usage.inputTokens)}/
                {usage?.contextWindow ? compact(usage.contextWindow) : "未知"}
                {percent == null ? "" : `（${percent.toFixed(1)}%）`}
              </span>
            </div>
            <div
              className="context-progress"
              role="progressbar"
              aria-label="上下文容量"
              aria-valuenow={percent ?? undefined}
              aria-valuemin={0}
              aria-valuemax={100}
            >
              <span style={{ width: `${Math.min(100, percent ?? 0)}%` }} />
            </div>
            <div
              className="context-breakdown"
              data-testid="context-breakdown"
              title="分类占比按实际请求文本与工具 Schema 的字符数计算；顶部 token 总量来自服务端。"
            >
              {(breakdown.length
                ? [...breakdown].sort((a, b) => b.chars - a.chars)
                : Object.keys(labels).map((source) => ({ source: source as keyof typeof labels, chars: 0 }))
              ).map((item, index) => (
                <div key={item.source}>
                  <i style={{ opacity: Math.max(0.25, 1 - index * 0.17) }} />
                  <span>{labels[item.source]}</span>
                  <strong>
                    {totalChars
                      ? `${((item.chars / totalChars) * 100).toFixed(1).replace(/\.0$/, "")}%`
                      : "—"}
                  </strong>
                </div>
              ))}
            </div>
            <div className="context-cache">
              <span>平均缓存命中率</span>
              <strong>
                {usage?.averageCacheHitRate == null
                  ? "未知"
                  : `${(usage.averageCacheHitRate * 100).toFixed(1)}%`}
              </strong>
            </div>
          </div>
        </div>
      )}
      <Menu.Root open={open} onOpenChange={onOpenChange}>
        <Menu.Trigger
          className="model-trigger"
          aria-label="模型选择"
          title={
            chosen
              ? `${provider?.name ?? chosen.provider} · ${chosen.modelId} · ${modelReasoningLabel(configured, chosen.reasoning)}\n${useStore.getState().sessions.get(view.sessionId)?.cwd ?? ""}`
              : "选择模型与思考程度"
          }
          disabled={updating}
        >
          <span className="model-label">
            {chosen && configured && controls?.selectionValid
              ? configured.name || configured.id
              : chosen
                ? "重新选择模型"
                : "模型选择"}
          </span>
          {chosen && configured && controls?.selectionValid && chosen.reasoning !== "none" && (
            <span className="model-reasoning">{modelReasoningLabel(configured, chosen.reasoning)}</span>
          )}
          <ChevronDown size={14} />
        </Menu.Trigger>
        <Menu.Portal>
          <Menu.Content ref={mainMenu} className="selection-menu" side="top" align="end" collisionPadding={8}>
            {settings?.providers
              .filter((p) => p.enabled !== false && p.models.some((m) => m.enabled !== false))
              .map((p) => (
                <Menu.Group key={p.id}>
                  <Menu.Label className="menu-label">{p.name}</Menu.Label>
                  {p.models
                    .filter((m) => m.enabled !== false)
                    .map((m) => {
                      const id = `${p.id}:${m.id}`,
                        supported = availablePresets(m);
                      return (
                        <Menu.Sub
                          key={id}
                          open={active === id}
                          onOpenChange={(value) =>
                            setActive((current) => (value ? id : current === id ? undefined : current))
                          }
                        >
                          <Menu.SubTrigger
                            className="menu-item"
                            disabled={updating}
                            onFocus={() => setActive(id)}
                            onClick={() => {
                              setActive(id);
                              if (chosen?.provider !== p.id || chosen.modelId !== m.id)
                                select(p.id, m.id, defaultPreset(m), false);
                            }}
                          >
                            <span>{m.name || m.id}</span>
                            <ChevronRight size={12} />
                          </Menu.SubTrigger>
                          <Menu.Portal>
                            <Menu.SubContent
                              className="selection-menu"
                              collisionPadding={8}
                              onFocusOutside={(event) => {
                                if (event.target === mainMenu.current) event.preventDefault();
                              }}
                            >
                              {supported.map((reasoning) => (
                                <Menu.Item
                                  key={reasoning}
                                  className="menu-item"
                                  disabled={updating}
                                  onSelect={(event) => {
                                    event.preventDefault();
                                    select(p.id, m.id, reasoning);
                                  }}
                                >
                                  <span>
                                    {modelReasoningLabel(m, reasoning)}
                                    {m.defaultThinkingLevel && defaultPreset(m) === reasoning && (
                                      <small> · 默认</small>
                                    )}
                                  </span>
                                  {chosen?.provider === p.id &&
                                    chosen.modelId === m.id &&
                                    chosen.reasoning === reasoning && <Check size={12} />}
                                </Menu.Item>
                              ))}
                            </Menu.SubContent>
                          </Menu.Portal>
                        </Menu.Sub>
                      );
                    })}
                </Menu.Group>
              ))}
            {!settings?.providers.some(
              (p) => p.enabled !== false && p.models.some((m) => m.enabled !== false),
            ) && (
              <Menu.Item className="menu-item" onSelect={onSettings}>
                配置模型…
              </Menu.Item>
            )}
          </Menu.Content>
        </Menu.Portal>
      </Menu.Root>
    </div>
  );
}
