import type { ReactNode } from "react";
import { useLayoutEffect, useRef, useState } from "react";

// Reveal keyboard selections inside the list without scrolling any ancestor.
export function SuggestionOptions({
  selectedIndex,
  options,
  children,
  label,
}: {
  selectedIndex: number;
  options: readonly unknown[];
  children: ReactNode;
  label?: string;
}) {
  const root = useRef<HTMLDivElement>(null);
  const [mask, setMask] = useState<string>();
  const updateMask = () => {
    const element = root.current;
    if (!element) return;
    const top = element.scrollTop > 1;
    const bottom = element.scrollTop < element.scrollHeight - element.clientHeight - 1;
    setMask(
      top || bottom
        ? `linear-gradient(to bottom, ${top ? "transparent" : "black"} 0px, black 24px, black calc(100% - 24px), ${bottom ? "transparent" : "black"} 100%)`
        : undefined,
    );
  };
  useLayoutEffect(() => {
    const element = root.current;
    if (!element) return;
    const option = element.querySelectorAll<HTMLElement>('[role="option"]')[selectedIndex];
    if (option) {
      const viewport = element.getBoundingClientRect();
      const row = option.getBoundingClientRect();
      if (row.top < viewport.top) element.scrollTop += row.top - viewport.top;
      else if (row.bottom > viewport.bottom) element.scrollTop += row.bottom - viewport.bottom;
    }
    updateMask();
  }, [selectedIndex, options]);
  useLayoutEffect(() => {
    const observer = new ResizeObserver(updateMask);
    if (root.current) observer.observe(root.current);
    return () => observer.disconnect();
  }, []);
  return (
    <div
      ref={root}
      className="command-options"
      {...(label ? { role: "listbox", "aria-label": label } : {})}
      onScroll={updateMask}
      style={{ maskImage: mask, maskRepeat: "no-repeat", maskSize: "100% 100%" }}
    >
      {children}
    </div>
  );
}
