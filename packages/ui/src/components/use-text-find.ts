import { type RefObject, useEffect, useRef, useState } from "react";
import {
  FindIndex,
  type FindMatch,
  type FindRequest,
  type FindState,
  type FindTarget,
  findMatchKey,
  findSearchTargetIndex,
  normalizeFindQuery,
} from "../find.ts";
import { FindDomIndex, mountedFindElements } from "./find-dom.ts";

export const findHighlightLimit = 2000;
function highlightRanges(ranges: readonly Range[]): Highlight {
  const highlight = new Highlight();
  for (const range of ranges) highlight.add(range);
  return highlight;
}

export const findHighlightCSS = ["conversation", "changes"]
  .map(
    (scope) => `
::highlight(zpi-${scope}-find) { background-color: var(--color-find-highlight); color: var(--color-foreground); }
::highlight(zpi-${scope}-find-active) { background-color: var(--color-find-highlight-active); color: var(--color-foreground); }
`,
  )
  .join("\n");
function ensureHighlightStyle() {
  const style = document.getElementById("zpi-find-style") ?? document.createElement("style");
  style.id = "zpi-find-style";
  if (style.textContent !== findHighlightCSS) style.textContent = findHighlightCSS;
  if (!style.isConnected) document.head.append(style);
}
/** Search rendered message text, or a supplied index for lazily mounted diff files. */
export function useTextFind({
  rootRef,
  request,
  content,
  scopeKey,
  targets,
  onStateChange,
  onNavigate,
  highlightScope = "conversation",
  navigateUnmounted = true,
}: {
  highlightScope?: "conversation" | "changes";
  rootRef: RefObject<HTMLDivElement | null>;
  request?: FindRequest;
  content: unknown;
  scopeKey: string;
  targets?: readonly FindTarget[];
  onStateChange?: (state: FindState) => void;
  onNavigate?: (match: FindMatch, range?: Range) => void;
  /** Revisit an already revealed match when its DOM range disappears (for lazy diff files). */
  navigateUnmounted?: boolean;
}) {
  const previous = useRef<{
    query: string;
    index: number;
    navigation: number;
    key?: string;
    scroll?: string;
    revealed?: string;
    hasRange?: boolean;
  }>({ query: "", index: -1, navigation: -1 });
  const [findIndex] = useState(() => new FindIndex());
  const [dom] = useState(() => new FindDomIndex());
  const highlightName = `zpi-${highlightScope}-find`;
  const owned = useRef<{
    all?: Highlight;
    active?: Highlight;
    ranges?: Range[];
    activeRanges?: Range[];
  }>({});
  const clear = () => {
    if (CSS.highlights.get(highlightName) === owned.current.all) CSS.highlights.delete(highlightName);
    if (CSS.highlights.get(`${highlightName}-active`) === owned.current.active)
      CSS.highlights.delete(`${highlightName}-active`);
    owned.current = {};
  };
  useEffect(() => {
    previous.current = { query: "", index: -1, navigation: -1 };
    findIndex.clear();
    dom.clear();
  }, [scopeKey, findIndex, dom]);
  useEffect(() => {
    const root = rootRef.current;
    const query = normalizeFindQuery(request?.query ?? "");
    if (!root || !query || !request) {
      clear();
      findIndex.clear();
      dom.clear();
      previous.current = { query: "", index: -1, navigation: -1 };
      return;
    }
    let frame = 0;
    ensureHighlightStyle();
    const observers = new Map<Node, MutationObserver>();
    const scan = () => {
      for (const [node, observer] of observers) {
        dom.invalidate(observer.takeRecords());
        if (node instanceof ShadowRoot && !root.contains(node.host)) {
          observer.disconnect();
          observers.delete(node);
        }
      }
      const elements = mountedFindElements(root);
      const source = targets
        ? targets.map((target) => {
            const element = elements.get(target.key)?.[0];
            return element && (target.rendered || element.querySelector("[data-find-rendered]"))
              ? { ...target, text: dom.target(element, target.key).text }
              : target;
          })
        : [...elements].map(([key, nodes]) => dom.target(nodes[0], key));
      const matches = findIndex.search(source, query);
      const last = previous.current;
      const explicit =
        query !== last.query ||
        request.activeIndex !== last.index ||
        request.navigationId !== last.navigation;
      const rebased = explicit ? -1 : matches.findIndex((match) => findMatchKey(match) === last.key);
      const targetIndex = findSearchTargetIndex(matches, request);
      const index = !matches.length
        ? -1
        : targetIndex >= 0
          ? targetIndex
          : rebased >= 0
            ? rebased
            : request.activeIndex >= 0 && request.activeIndex < matches.length
              ? request.activeIndex
              : 0;
      const active = matches[index];
      const key = active ? findMatchKey(active) : undefined;
      const ranges: Range[] = [],
        activeRanges: Range[] = [];
      for (const match of matches)
        for (const element of elements.get(match.key) ?? []) {
          const cache = ranges.length < findHighlightLimit;
          if (!cache && match !== active) continue;
          const range = dom.range(element, match, query, cache);
          if (range) {
            if (cache) ranges.push(range);
            if (match === active) activeRanges.push(range);
          }
        }
      const same = (a: Range[] | undefined, b: Range[]) =>
        a?.length === b.length &&
        a.every(
          (range, i) =>
            range.startContainer === b[i].startContainer &&
            range.endContainer === b[i].endContainer &&
            range.startOffset === b[i].startOffset &&
            range.endOffset === b[i].endOffset,
        );
      // Navigation changes only the active highlight; stable history keeps its ranges and registry entry.
      if (!same(owned.current.ranges, ranges) || CSS.highlights.get(highlightName) !== owned.current.all) {
        owned.current.all = highlightRanges(ranges);
        owned.current.ranges = ranges;
        CSS.highlights.set(highlightName, owned.current.all);
      }
      if (
        !same(owned.current.activeRanges, activeRanges) ||
        CSS.highlights.get(`${highlightName}-active`) !== owned.current.active
      ) {
        owned.current.active = highlightRanges(activeRanges);
        owned.current.active.priority = 1;
        owned.current.activeRanges = activeRanges;
        CSS.highlights.set(`${highlightName}-active`, owned.current.active);
      }
      onStateChange?.({ total: matches.length, activeIndex: index });
      const scroll = `${query}:${key}:${request.navigationId}`;
      const hasRange = activeRanges.length > 0;
      previous.current = {
        query,
        index,
        navigation: request.navigationId,
        key,
        scroll: last.scroll,
        revealed: last.revealed,
        hasRange,
      };
      if (
        active &&
        (scroll !== last.scroll ||
          (hasRange && scroll !== last.revealed) ||
          (!hasRange && last.hasRange && targets && navigateUnmounted))
      ) {
        onNavigate?.(active, activeRanges[0]);
        previous.current.scroll = scroll;
        if (hasRange) previous.current.revealed = scroll;
      }
      for (const host of root.querySelectorAll("diffs-container")) {
        if (!host.shadowRoot || observers.has(host.shadowRoot)) continue;
        observe(host.shadowRoot);
      }
    };
    const schedule = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        scan();
      });
    };
    const observe = (node: Node) => {
      const observer = new MutationObserver((records) => {
        dom.invalidate(records);
        schedule();
      });
      observer.observe(node, {
        childList: true,
        characterData: true,
        subtree: true,
        attributes: true,
        attributeFilter: [
          "hidden",
          "class",
          "contenteditable",
          "data-find-key",
          "data-find-index",
          "data-find-ignore",
          "data-conversation-inline-link",
          "data-diff-id",
          "data-line",
          "data-line-index",
          "data-code",
          "data-find-rendered",
        ],
      });
      observers.set(node, observer);
    };
    observe(root);
    root.addEventListener("zpi-diff-render", schedule);
    schedule();
    return () => {
      cancelAnimationFrame(frame);
      root.removeEventListener("zpi-diff-render", schedule);
      for (const observer of observers.values()) {
        // React may have committed changed text before the previous effect is cleaned up.
        dom.invalidate(observer.takeRecords());
        observer.disconnect();
      }
    };
  }, [
    rootRef,
    request,
    content,
    scopeKey,
    targets,
    onStateChange,
    onNavigate,
    highlightName,
    navigateUnmounted,
    findIndex,
    dom,
  ]);
  useEffect(
    () => () => {
      clear();
    },
    [highlightName],
  );
}
