// Query rail adapted from ZCode's ConversationTurnNavigator (Apache-2.0).
import * as HoverCard from "@radix-ui/react-hover-card";
import { memo, type RefObject, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ConversationQuery } from "../conversation-run-partition.ts";
import { parseSelectionPrompt } from "../conversation-selections.ts";
import type { RunView } from "../types.ts";

// Keep previews bounded even when a run contains a very long assistant response.
function previewText(blocks: RunView["orderedBlocks"]): string {
  let preview = "";
  let paragraphs = 1;
  let whitespace = false;
  let newlines = 0;
  for (const block of blocks) {
    if (block.type !== "text") continue;
    if (preview) {
      whitespace = true;
      newlines = 2;
    }
    for (const character of block.text) {
      if (/\s/u.test(character)) {
        whitespace = true;
        if (character === "\n") newlines++;
        continue;
      }
      if (whitespace && preview) {
        if (newlines >= 2) {
          if (paragraphs >= 2) return preview;
          paragraphs++;
          preview += "\n";
        } else preview += " ";
      }
      preview += character;
      whitespace = false;
      newlines = 0;
      if (preview.length > 220) return `${preview.slice(0, 217).trimEnd()}...`;
    }
  }
  return preview;
}

const rowHeight = 10;
const overscan = 6;

export function ConversationNavigator({
  enabled = true,
  history,
  tail = [],
  scrollRoot,
  onJump,
  busy,
}: {
  enabled?: boolean;
  history: readonly ConversationQuery[];
  tail?: readonly ConversationQuery[];
  scrollRoot: RefObject<HTMLDivElement | null>;
  onJump: (id: string, queryKey: string) => void;
  busy: boolean;
}) {
  const [focus, setFocus] = useState<number>();
  const [activeId, setActiveId] = useState<string>();
  const rail = useRef<HTMLDivElement>(null);
  const [windowRange, setWindowRange] = useState({ top: 0, height: 600 });
  const count = history.length + tail.length;
  const tailIds = tail.map((item) => item.key).join("\n");
  const itemIds = useMemo(
    () => [...history.map((item) => item.key), ...tail.map((item) => item.key)],
    [history, tailIds],
  );
  const itemIndexes = useMemo(() => new Map(itemIds.map((id, index) => [id, index])), [itemIds]);
  useLayoutEffect(() => {
    const root = scrollRoot.current;
    if (!enabled || !root || itemIds.length < 2) return;
    const ids = new Set(itemIds);
    const update = () => {
      const nodes = Array.from(root.querySelectorAll<HTMLElement>("[data-query-key]")).filter(
        (node) => node.dataset.queryKey && ids.has(node.dataset.queryKey),
      );
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
      setActiveId(nodes[Math.max(0, low - 1)]?.dataset.queryKey);
    };
    update();
    root.addEventListener("scroll", update, { passive: true });
    root.addEventListener("zpi-history-window", update);
    return () => {
      root.removeEventListener("scroll", update);
      root.removeEventListener("zpi-history-window", update);
    };
  }, [enabled, scrollRoot, itemIds]);
  const active = activeId === undefined ? -1 : (itemIndexes.get(activeId) ?? -1);
  useEffect(() => {
    if (!enabled || active < 0) return;
    const element = rail.current;
    if (!element) return;
    const top = active * rowHeight;
    if (top < element.scrollTop) element.scrollTop = top;
    else if (top + rowHeight > element.scrollTop + element.clientHeight)
      element.scrollTop = top + rowHeight - element.clientHeight;
  }, [active, enabled]);
  useEffect(() => {
    const element = rail.current;
    if (!element) return;
    const update = () => setWindowRange({ top: element.scrollTop, height: element.clientHeight });
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, [count >= 2]);
  if (count < 2) return null;
  const start = Math.max(0, Math.floor(windowRange.top / rowHeight) - overscan);
  const end = Math.min(count, Math.ceil((windowRange.top + windowRange.height) / rowHeight) + overscan);
  return (
    <nav
      className="conversation-navigator"
      aria-label="对话问题导航"
      aria-busy={busy}
      aria-hidden={!enabled}
      data-visible={enabled}
      inert={!enabled}
    >
      <div
        className="conversation-navigator-rail"
        ref={rail}
        onPointerLeave={() => setFocus(undefined)}
        onScroll={(event) => {
          setFocus(undefined);
          setWindowRange({ top: event.currentTarget.scrollTop, height: event.currentTarget.clientHeight });
        }}
      >
        <div style={{ height: count * rowHeight, position: "relative" }}>
          {Array.from({ length: end - start }, (_, offset) => {
            const index = start + offset;
            const item = index < history.length ? history[index] : tail[index - history.length];
            if (!item) return null;
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
                key={item.key}
                item={item}
                index={index}
                active={index === active}
                scale={scale}
                opacity={opacity}
                focused={distance === 0}
                enabled={enabled}
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
  item,
  index,
  active,
  scale,
  opacity,
  focused,
  enabled,
  onFocus,
  onJump,
  setActiveId,
}: {
  item: ConversationQuery;
  index: number;
  active: boolean;
  scale: number;
  opacity: number;
  focused: boolean;
  enabled: boolean;
  onFocus: (index: number | undefined) => void;
  onJump: (id: string, queryKey: string) => void;
  setActiveId: (id: string) => void;
}) {
  const { run } = item;
  const { user, assistant } = useMemo(
    () => ({
      user: parseSelectionPrompt(item.text).text.trim() || "用户输入",
      assistant:
        previewText(run.orderedBlocks) || (run.status === "running" ? "助手仍在工作" : "暂无助手正文"),
    }),
    [run, item.text],
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
            setActiveId(item.key);
            onJump(run.runId, item.key);
          }}
        >
          <span style={{ transform: `scaleX(${scale})`, opacity }} data-highlighted={focused || active} />
        </button>
      </HoverCard.Trigger>
      <HoverCard.Portal>
        <HoverCard.Content
          hidden={!enabled}
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
