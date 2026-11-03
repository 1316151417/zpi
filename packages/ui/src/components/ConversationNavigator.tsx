// Query rail adapted from ZCode's ConversationTurnNavigator (Apache-2.0).
import * as HoverCard from "@radix-ui/react-hover-card";
import { memo, type RefObject, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { parseSelectionPrompt } from "../conversation-selections.ts";
import type { RunView } from "../types.ts";

const rowHeight = 10;
const overscan = 6;

export function ConversationNavigator({
  runs,
  scrollRoot,
  onJump,
  busy,
}: {
  runs: RunView[];
  scrollRoot: RefObject<HTMLDivElement | null>;
  onJump: (id: string) => void;
  busy: boolean;
}) {
  const [focus, setFocus] = useState<number>();
  const [activeId, setActiveId] = useState<string>();
  const rail = useRef<HTMLDivElement>(null);
  const [windowRange, setWindowRange] = useState({ top: 0, height: 600 });
  const items = runs;
  useLayoutEffect(() => {
    const root = scrollRoot.current;
    if (!root || items.length < 2) return;
    const ids = new Set(items.map((run) => run.runId));
    const nodes = Array.from(root.querySelectorAll<HTMLElement>("[data-history-run]")).filter(
      (node) => node.dataset.historyRun && ids.has(node.dataset.historyRun),
    );
    const update = () => {
      if (!nodes.length) return;
      const top = root.getBoundingClientRect().top + 1;
      let low = 0;
      let high = nodes.length;
      while (low < high) {
        const mid = (low + high) >>> 1;
        const node = nodes[mid];
        if (node && node.getBoundingClientRect().top <= top) low = mid + 1;
        else high = mid;
      }
      setActiveId(nodes[Math.max(0, low - 1)]?.dataset.historyRun);
    };
    update();
    root.addEventListener("scroll", update, { passive: true });
    return () => root.removeEventListener("scroll", update);
  }, [scrollRoot, items]);
  const active = items.findIndex((item) => item.runId === activeId);
  useEffect(() => {
    if (active < 0) return;
    const element = rail.current;
    if (!element) return;
    const top = active * rowHeight;
    if (top < element.scrollTop) element.scrollTop = top;
    else if (top + rowHeight > element.scrollTop + element.clientHeight)
      element.scrollTop = top + rowHeight - element.clientHeight;
  }, [active]);
  useEffect(() => {
    const element = rail.current;
    if (!element) return;
    const update = () => setWindowRange({ top: element.scrollTop, height: element.clientHeight });
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, [items.length >= 2]);
  if (items.length < 2) return null;
  const start = Math.max(0, Math.floor(windowRange.top / rowHeight) - overscan);
  const end = Math.min(
    items.length,
    Math.ceil((windowRange.top + windowRange.height) / rowHeight) + overscan,
  );
  return (
    <nav className="conversation-navigator" aria-label="对话问题导航" aria-busy={busy}>
      <div
        className="conversation-navigator-rail"
        ref={rail}
        onPointerLeave={() => setFocus(undefined)}
        onScroll={(event) => {
          setFocus(undefined);
          setWindowRange({ top: event.currentTarget.scrollTop, height: event.currentTarget.clientHeight });
        }}
      >
        <div style={{ height: items.length * rowHeight, position: "relative" }}>
          {items.slice(start, end).map((run, offset) => {
            const index = start + offset;
            const distance = focus === undefined ? 3 : Math.abs(index - focus);
            const scale = distance === 0 ? 2.6 : distance === 1 ? 1.7 : distance === 2 ? 1.25 : 1;
            const opacity =
              distance === 0
                ? 1
                : distance === 1
                  ? 0.86
                  : distance === 2
                    ? 0.72
                    : index === active
                      ? 0.9
                      : 0.58;
            return (
              <NavigatorItem
                key={run.runId}
                run={run}
                index={index}
                active={index === active}
                scale={scale}
                opacity={opacity}
                focused={distance === 0}
                onFocus={setFocus}
                onJump={onJump}
                setActiveId={setActiveId}
              />
            );
          })}
        </div>
      </div>
    </nav>
  );
}

const NavigatorItem = memo(function NavigatorItem({
  run,
  index,
  active,
  scale,
  opacity,
  focused,
  onFocus,
  onJump,
  setActiveId,
}: {
  run: RunView;
  index: number;
  active: boolean;
  scale: number;
  opacity: number;
  focused: boolean;
  onFocus: (index: number | undefined) => void;
  onJump: (id: string) => void;
  setActiveId: (id: string) => void;
}) {
  const { user, assistant } = useMemo(
    () => ({
      user: parseSelectionPrompt(run.userMessage).text.trim() || "用户输入",
      assistant:
        run.orderedBlocks
          .flatMap((block) => (block.type === "text" ? [block.text.trim()] : []))
          .filter(Boolean)
          .join("\n\n") || (run.status === "running" ? "助手仍在工作" : "暂无助手正文"),
    }),
    [run],
  );
  return (
    <HoverCard.Root openDelay={120} closeDelay={80}>
      <HoverCard.Trigger asChild>
        <button
          style={{ position: "absolute", top: index * rowHeight }}
          type="button"
          className="conversation-navigator-item"
          aria-label={`跳转到第 ${index + 1} 条问题`}
          aria-current={active ? "location" : undefined}
          onPointerEnter={() => onFocus(index)}
          onFocus={() => onFocus(index)}
          onBlur={() => onFocus(undefined)}
          onClick={() => {
            setActiveId(run.runId);
            onJump(run.runId);
          }}
        >
          <span style={{ transform: `scaleX(${scale})`, opacity }} data-highlighted={focused || active} />
        </button>
      </HoverCard.Trigger>
      <HoverCard.Portal>
        <HoverCard.Content
          className="conversation-navigator-tooltip"
          side="right"
          align="start"
          sideOffset={8}
          collisionPadding={16}
        >
          <p className="conversation-navigator-user">{user}</p>
          <p className="conversation-navigator-answer">{assistant}</p>
        </HoverCard.Content>
      </HoverCard.Portal>
    </HoverCard.Root>
  );
});
