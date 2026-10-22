// ZCode side-pane-full-view/model geometry (Apache-2.0), using the existing workspace host.
export const floatingAnchors = [
  "top-left",
  "top-right",
  "left-center",
  "right-center",
  "bottom-left",
  "bottom-center",
  "bottom-right",
] as const;
export type FloatingAnchor = (typeof floatingAnchors)[number];
export interface FloatingRect {
  left: number;
  top: number;
  width: number;
  height: number;
}
export function floatingPosition(
  anchor: FloatingAnchor,
  slot: FloatingRect,
  size: { width: number; height: number },
) {
  return {
    left: Math.max(
      slot.left,
      Math.min(
        slot.left + slot.width - size.width,
        anchor.includes("left")
          ? slot.left + 16
          : anchor.includes("right")
            ? slot.left + slot.width - size.width - 16
            : slot.left + (slot.width - size.width) / 2,
      ),
    ),
    top: Math.max(
      slot.top,
      Math.min(
        slot.top + slot.height - size.height,
        anchor.startsWith("top")
          ? slot.top + 16
          : anchor.startsWith("bottom")
            ? slot.top + slot.height - size.height - 16
            : slot.top + (slot.height - size.height) / 2,
      ),
    ),
  };
}
export function nearestFloatingAnchor(
  position: { left: number; top: number },
  slot: FloatingRect,
  size: { width: number; height: number },
): FloatingAnchor {
  return floatingAnchors.reduce((best, anchor) => {
    const distance = (value: FloatingAnchor) => {
      const point = floatingPosition(value, slot, size);
      return Math.hypot(point.left - position.left, point.top - position.top);
    };
    return distance(anchor) < distance(best) ? anchor : best;
  }, "bottom-right" as FloatingAnchor);
}
export function floatingAnswerPreview(markdown: string) {
  return markdown
    .replace(/```[\s\S]*?(```|$)/g, " ")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+[.)])\s+/gm, "")
    .replace(/(\*\*|~~|\*)(\S(?:.*?\S)?)\1/g, "$2")
    .replace(/\s+/g, " ")
    .trim();
}
