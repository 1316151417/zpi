import { type RefObject, useEffect, useRef } from "react";
import {
  buildFindMatches,
  type FindMatch,
  type FindRequest,
  type FindState,
  type FindTarget,
  findMatchKey,
  normalizeFindQuery,
} from "../find.ts";

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
function textNodes(element: Element): Text[] {
  const nodes: Text[] = [];
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      return node.parentElement?.closest(
        'button,input,textarea,select,script,style,[hidden],.katex-mathml,[contenteditable="true"],[data-find-ignore]',
      )
        ? NodeFilter.FILTER_REJECT
        : NodeFilter.FILTER_ACCEPT;
    },
  });
  for (let node = walker.nextNode(); node; node = walker.nextNode()) nodes.push(node as Text);
  return nodes;
}
function readText(element: Element) {
  let text = "",
    previousBlock: Element | null = null;
  const segments: { node: Text; start: number; end: number }[] = [];
  for (const node of textNodes(element)) {
    const block = node.parentElement?.closest("p,li,pre,h1,h2,h3,h4,h5,h6,tr") ?? null;
    if (text && block !== previousBlock) text += "\n";
    const start = text.length;
    text += node.data;
    segments.push({ node, start, end: text.length });
    previousBlock = block;
  }
  return { text, segments };
}
function rangeFor(element: Element, match: FindMatch): Range | undefined {
  const { segments } = readText(element);
  const range = document.createRange();
  let started = false;
  for (const { node, start, end } of segments) {
    if (!started && match.start >= start && match.start < end) {
      range.setStart(node, match.start - start);
      started = true;
    }
    if (started && match.end <= end) {
      range.setEnd(node, match.end - start);
      return range;
    }
  }
}
function mountedElements(root: HTMLElement): Map<string, Element[]> {
  const elements = new Map<string, Element[]>();
  const add = (key: string, element: Element) => elements.set(key, [...(elements.get(key) ?? []), element]);
  for (const element of root.querySelectorAll<HTMLElement>("[data-find-key]"))
    add(element.dataset.findKey as string, element);
  for (const entry of root.querySelectorAll<HTMLElement>("[data-diff-id]"))
    for (const host of entry.querySelectorAll("diffs-container"))
      for (const line of host.shadowRoot?.querySelectorAll<HTMLElement>("[data-code] [data-line]") ?? [])
        add(`${entry.dataset.diffId}:${line.dataset.lineIndex?.split(",")[0]}`, line);
  return elements;
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
}: {
  highlightScope?: "conversation" | "changes";
  rootRef: RefObject<HTMLDivElement | null>;
  request?: FindRequest;
  content: unknown;
  scopeKey: string;
  targets?: readonly FindTarget[];
  onStateChange?: (state: FindState) => void;
  onNavigate?: (match: FindMatch, range?: Range) => void;
}) {
  const previous = useRef<{
    query: string;
    index: number;
    navigation: number;
    key?: string;
    scroll?: string;
  }>({ query: "", index: -1, navigation: -1 });
  const highlightName = `zpi-${highlightScope}-find`;
  const owned = useRef<{ all?: Highlight; active?: Highlight }>({});
  const clear = () => {
    if (CSS.highlights.get(highlightName) === owned.current.all) CSS.highlights.delete(highlightName);
    if (CSS.highlights.get(`${highlightName}-active`) === owned.current.active)
      CSS.highlights.delete(`${highlightName}-active`);
    owned.current = {};
  };
  useEffect(() => {
    previous.current = { query: "", index: -1, navigation: -1 };
  }, [scopeKey]);
  useEffect(() => {
    const root = rootRef.current;
    const query = normalizeFindQuery(request?.query ?? "");
    if (!root || !query || !request) {
      clear();
      previous.current = { query: "", index: -1, navigation: -1 };
      return;
    }
    let frame = 0;
    ensureHighlightStyle();
    const observers: MutationObserver[] = [];
    const scan = () => {
      const elements = mountedElements(root);
      const source =
        targets ??
        [...elements].map(([key, nodes]) => ({
          key,
          text: readText(nodes[0]).text,
        }));
      const matches = buildFindMatches(source, query);
      const last = previous.current;
      const explicit =
        query !== last.query ||
        request.activeIndex !== last.index ||
        request.navigationId !== last.navigation;
      const rebased = explicit ? -1 : matches.findIndex((match) => findMatchKey(match) === last.key);
      const index = !matches.length
        ? -1
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
          const range = rangeFor(element, match);
          if (range) {
            ranges.push(range);
            if (match === active) activeRanges.push(range);
          }
        }
      const all = new Highlight(...ranges),
        current = new Highlight(...activeRanges);
      current.priority = 1;
      CSS.highlights.set(highlightName, all);
      CSS.highlights.set(`${highlightName}-active`, current);
      owned.current = { all, active: current };
      onStateChange?.({ total: matches.length, activeIndex: index });
      const scroll = `${query}:${key}:${request.navigationId}`;
      previous.current = { query, index, navigation: request.navigationId, key, scroll: last.scroll };
      if (active && (scroll !== last.scroll || (!activeRanges.length && targets))) {
        onNavigate?.(active, activeRanges[0]);
        if (activeRanges[0]) previous.current.scroll = scroll;
      }
      for (const host of root.querySelectorAll("diffs-container")) {
        if (!host.shadowRoot || observed.has(host.shadowRoot)) continue;
        observe(host.shadowRoot);
      }
    };
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(scan);
    };
    const observed = new Set<Node>();
    const observe = (node: Node) => {
      observed.add(node);
      const observer = new MutationObserver(schedule);
      observer.observe(node, { childList: true, characterData: true, subtree: true });
      observers.push(observer);
    };
    observe(root);
    root.addEventListener("zpi-diff-render", schedule);
    schedule();
    return () => {
      cancelAnimationFrame(frame);
      root.removeEventListener("zpi-diff-render", schedule);
      for (const observer of observers) observer.disconnect();
    };
  }, [rootRef, request, content, scopeKey, targets, onStateChange, onNavigate, highlightName]);
  useEffect(
    () => () => {
      clear();
    },
    [highlightName],
  );
}
