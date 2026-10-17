import { type RefObject, useEffect, useRef, useState } from "react";

/** Keep native selection anchors intact while incoming data continues to advance. */
export function useSelectionStableValue<T>(
  value: T,
  scopeKey: string,
  root: RefObject<HTMLElement | null>,
): T {
  const [snapshot, setSnapshot] = useState({ scopeKey, value });
  const deferred = useRef(false);
  useEffect(() => {
    // Re-evaluate on release even when no further stream or highlight update arrives.
    const changed = () => {
      if (deferred.current) setSnapshot((current) => ({ ...current }));
    };
    const owner = root.current?.ownerDocument ?? document;
    owner.addEventListener("selectionchange", changed);
    return () => owner.removeEventListener("selectionchange", changed);
  }, [root]);
  // Check the live range on every render: an async highlight can beat selectionchange.
  const selection = root.current?.ownerDocument.getSelection();
  let selected = false;
  if (root.current && selection && !selection.isCollapsed) {
    for (let index = 0; index < selection.rangeCount; index++) {
      if (selection.getRangeAt(index).intersectsNode(root.current)) {
        selected = true;
        break;
      }
    }
  }
  deferred.current = scopeKey === snapshot.scopeKey && selected && value !== snapshot.value;
  if (scopeKey !== snapshot.scopeKey || (!selected && value !== snapshot.value)) {
    setSnapshot({ scopeKey, value });
    return value;
  }
  return snapshot.value;
}
