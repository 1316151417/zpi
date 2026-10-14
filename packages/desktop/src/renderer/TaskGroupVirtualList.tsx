// Adapted from ZCode virtualized-{top-level,group-task}-list (Apache-2.0), aac4755666.
import { useVirtualizer } from "@tanstack/react-virtual";
import { type ReactNode, useLayoutEffect, useRef, useState } from "react";
export const taskGroupVirtualThreshold = 80;
export function TaskGroupVirtualList<T>({
  items,
  itemKey,
  estimate,
  renderItem,
}: {
  items: T[];
  itemKey(item: T): string;
  estimate(item: T): number;
  renderItem(item: T): ReactNode;
}) {
  const list = useRef<HTMLDivElement>(null);
  const [scroll, setScroll] = useState<HTMLElement | null>(null);
  const [margin, setMargin] = useState(0);
  const enabled = items.length > taskGroupVirtualThreshold;
  useLayoutEffect(() => {
    if (!enabled || !list.current) return;
    const element = list.current;
    const container = element.closest<HTMLElement>(".sidebar-sections");
    setScroll(container);
    const measure = () => {
      if (container)
        setMargin(
          element.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop,
        );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    if (container) observer.observe(container);
    return () => observer.disconnect();
  }, [enabled, items.length]);
  const virtualizer = useVirtualizer({
    count: enabled ? items.length : 0,
    getScrollElement: () => scroll,
    getItemKey: (index) => itemKey(items[index]),
    estimateSize: (index) => estimate(items[index]),
    overscan: 12,
    scrollMargin: margin,
    initialOffset: () => list.current?.closest<HTMLElement>(".sidebar-sections")?.scrollTop ?? 0,
    scrollToFn: (offset, { adjustments = 0, behavior }, instance) => {
      const element = instance.scrollElement;
      if (
        !element ||
        (offset === 0 &&
          adjustments === 0 &&
          behavior === undefined &&
          element.scrollTop > 0 &&
          instance.scrollOffset === 0)
      )
        return;
      element.scrollTo({ top: offset + adjustments, behavior });
    },
  });
  if (!enabled) return <>{items.map((item) => renderItem(item))}</>;
  return (
    <div ref={list} className="task-group-virtual-list" style={{ height: virtualizer.getTotalSize() }}>
      {virtualizer.getVirtualItems().map((row) => (
        <div
          key={row.key}
          data-index={row.index}
          ref={virtualizer.measureElement}
          className="task-group-virtual-row"
          style={{ transform: `translateY(${row.start - margin}px)` }}
        >
          {renderItem(items[row.index])}
        </div>
      ))}
    </div>
  );
}
