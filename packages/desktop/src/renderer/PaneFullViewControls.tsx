// Adapted from ZCode side-pane-full-view/ConversationHost (Apache-2.0).
import * as Menu from "@radix-ui/react-dropdown-menu";
import {
  ChevronDown,
  ChevronUp,
  GripVertical,
  Loader,
  Maximize2,
  MessageCircle,
  Minus,
  X,
} from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  type FloatingAnchor,
  floatingAnchors,
  floatingAnswerPreview,
  floatingPosition,
  nearestFloatingAnchor,
} from "./pane-full-view.ts";
import { type PaneFullView, updatePaneFullView } from "./pane-store.ts";
import { focusComposer, useStore } from "./store.ts";

export function PaneFullViewControls({ value, sessionId }: { value: PaneFullView; sessionId?: string }) {
  const root = useRef<HTMLDivElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [anchor, setAnchor] = useState<FloatingAnchor>(() => {
    const saved = localStorage.getItem("zpi.fullViewAnchor");
    return floatingAnchors.find((anchor) => anchor === saved) ?? "bottom-right";
  });
  const latest = useStore((state) =>
    state.views.get(sessionId ?? "")?.runs.findLast((run) => !run.subagentNotification),
  );
  const running = latest?.status === "running";
  const seen = useRef({ sessionId, runId: running ? undefined : latest?.runId });
  const [answer, setAnswer] = useState<{ sessionId?: string; text: string }>();
  useEffect(() => {
    if (value.surface === "conversation" || seen.current.sessionId !== sessionId) {
      seen.current = { sessionId, runId: running ? undefined : latest?.runId };
      setAnswer(undefined);
      return;
    }
    if (!running && latest && latest.runId !== seen.current.runId) {
      seen.current.runId = latest.runId;
      const text = latest.orderedBlocks
        .filter((block) => latest.finalAnswerBlockIds.includes(block.id))
        .flatMap((block) => (block.type === "text" ? [block.text] : []))
        .join("\n");
      if (text) setAnswer({ sessionId, text: floatingAnswerPreview(text) });
    }
  }, [latest, running, sessionId, value.surface]);
  const floating = (mode: PaneFullView["floating"]) => {
    updatePaneFullView({ ...value, floating: mode });
    setMenuOpen(false);
  };
  const geometry = () => {
    const element = root.current?.closest<HTMLElement>(".main");
    const content = element?.closest(".workspace-surface")?.querySelector(".right-pane-content");
    const header = content?.querySelector(".pane-header");
    if (!element || !content || !header) return;
    const rect = content.getBoundingClientRect();
    const top = header.getBoundingClientRect().bottom;
    return {
      element,
      content,
      slot: { left: rect.left, top, width: rect.width, height: Math.max(0, rect.bottom - top) },
      size: { width: element.offsetWidth, height: element.offsetHeight },
    };
  };
  useLayoutEffect(() => {
    const place = () => {
      const info = geometry();
      if (!info) return;
      // 完整视图只占右侧内容区；左栏开合、拖宽时以真实 slot 同步定位。
      for (const key of ["left", "top", "width", "height"] as const)
        info.element.style.setProperty(`--pane-slot-${key}`, `${info.slot[key]}px`);
      if (value.surface !== "side-pane") return;
      const size = { width: info.element.offsetWidth, height: info.element.offsetHeight };
      const point = floatingPosition(anchor, info.slot, size);
      info.element.style.setProperty("--pane-float-left", `${point.left}px`);
      info.element.style.setProperty("--pane-float-top", `${point.top}px`);
    };
    place();
    window.addEventListener("resize", place);
    const observer = new ResizeObserver(place);
    const info = geometry();
    if (info) {
      observer.observe(info.element);
      observer.observe(info.content);
    }
    return () => {
      window.removeEventListener("resize", place);
      observer.disconnect();
    };
  }, [anchor, value.floating, value.surface]);
  const drag = useRef<{ x: number; y: number; left: number; top: number; moved: boolean } | undefined>(
    undefined,
  );
  const start = (event: React.PointerEvent<HTMLElement>) => {
    if (event.button !== 0) return;
    const info = geometry();
    if (!info) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const rect = info.element.getBoundingClientRect();
    drag.current = { x: event.clientX, y: event.clientY, left: rect.left, top: rect.top, moved: false };
  };
  const move = (event: React.PointerEvent<HTMLElement>) => {
    const active = drag.current;
    if (!active) return;
    const dx = event.clientX - active.x,
      dy = event.clientY - active.y;
    if (Math.hypot(dx, dy) >= 4) active.moved = true;
    if (!active.moved) return;
    const info = geometry();
    if (!info) return;
    info.element.style.setProperty(
      "--pane-float-left",
      `${Math.max(info.slot.left, Math.min(info.slot.left + info.slot.width - info.size.width, active.left + dx))}px`,
    );
    info.element.style.setProperty(
      "--pane-float-top",
      `${Math.max(info.slot.top, Math.min(info.slot.top + info.slot.height - info.size.height, active.top + dy))}px`,
    );
  };
  const end = (event: React.PointerEvent<HTMLElement>) => {
    const active = drag.current,
      info = geometry();
    drag.current = undefined;
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
    if (!active || !info) return;
    if (active.moved) {
      const rect = info.element.getBoundingClientRect();
      const anchor = nearestFloatingAnchor(rect, info.slot, info.size);
      setAnchor(anchor);
      const point = floatingPosition(anchor, info.slot, info.size);
      info.element.style.setProperty("--pane-float-left", `${point.left}px`);
      info.element.style.setProperty("--pane-float-top", `${point.top}px`);
      localStorage.setItem("zpi.fullViewAnchor", anchor);
    } else if (value.floating === "minimized") {
      floating("collapsed");
      if (sessionId) focusComposer(sessionId);
    } else setMenuOpen((open) => !open);
  };
  const Icon = value.floating === "expanded" ? ChevronDown : ChevronUp;
  return (
    <div
      ref={root}
      className="pane-full-view-controls"
      data-anchor={anchor}
      data-menu-open={menuOpen}
      hidden={value.surface !== "side-pane"}
    >
      {answer && answer.sessionId === sessionId && (
        <div className="pane-floating-answer">
          <button
            aria-label="展开消息"
            onClick={() => {
              setAnswer(undefined);
              floating("expanded");
            }}
          >
            {answer.text}
          </button>
          <button
            className="pane-floating-answer-close"
            aria-label="关闭回答预览"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => setAnswer(undefined)}
          >
            <X size={12} />
          </button>
        </div>
      )}
      {value.floating === "minimized" ? (
        <button
          className="pane-floating-restore"
          aria-label="展开编辑器"
          onPointerDown={start}
          onPointerMove={move}
          onPointerUp={end}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              floating("collapsed");
              if (sessionId) focusComposer(sessionId);
            }
          }}
        >
          {running ? <Loader size={16} className="review-spinning" /> : <MessageCircle size={16} />}
        </button>
      ) : (
        <>
          <button
            className="pane-header-action"
            aria-label="最小化编辑器"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => floating("minimized")}
          >
            <Minus size={16} />
          </button>
          <button
            className="pane-header-action"
            aria-label={value.floating === "expanded" ? "收起消息" : "展开消息"}
            aria-expanded={value.floating === "expanded"}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => floating(value.floating === "expanded" ? "collapsed" : "expanded")}
          >
            <Icon size={16} />
          </button>
          {running && (
            <span className="pane-floating-status" role="status" aria-label="运行中" title="运行中">
              <Loader size={16} className="review-spinning" />
            </span>
          )}
          <Menu.Root open={menuOpen} onOpenChange={setMenuOpen} modal={false}>
            <Menu.Trigger asChild>
              <button
                className="pane-header-action pane-floating-grip"
                aria-label="拖动以移动 · 点击查看选项"
                title="拖动以移动 · 点击查看选项"
                onPointerDown={start}
                onPointerMove={move}
                onPointerUp={end}
                onLostPointerCapture={() => {
                  drag.current = undefined;
                }}
              >
                <GripVertical size={16} />
              </button>
            </Menu.Trigger>
            <Menu.Portal>
              <Menu.Content className="parity-menu pane-floating-menu" align="end" side="top" sideOffset={4}>
                <Menu.Item
                  className="parity-menu-item"
                  onSelect={() => updatePaneFullView({ ...value, surface: "conversation" })}
                >
                  <Maximize2 size={16} />
                  在完整视图中打开
                </Menu.Item>
                <Menu.Item className="parity-menu-item" onSelect={() => floating("minimized")}>
                  <Minus size={16} />
                  最小化编辑器
                </Menu.Item>
              </Menu.Content>
            </Menu.Portal>
          </Menu.Root>
        </>
      )}
    </div>
  );
}
