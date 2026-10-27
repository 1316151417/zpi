import { type FindMatch, type FindTarget, findTextBlockTags } from "../find.ts";

const blockSelector = findTextBlockTags.join(",");

function readText(element: Element, includeHidden: boolean) {
  let text = "",
    previousBlock: Element | null = null;
  const segments: { node: Text; start: number; end: number }[] = [];
  const walker = element.ownerDocument.createTreeWalker(element, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      // Inline links render as buttons, but their labels are part of the message text.
      return node.parentElement?.closest(
        'button:not([data-conversation-inline-link="true"]),input,textarea,select,script,style,dialog,.katex-mathml,[contenteditable="true"],[data-find-ignore]',
      ) ||
        (!includeHidden && node.parentElement?.closest("[hidden]"))
        ? NodeFilter.FILTER_REJECT
        : NodeFilter.FILTER_ACCEPT;
    },
  });
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const block = node.parentElement?.closest(blockSelector) ?? null;
    if (text && block !== previousBlock) text += "\n";
    const start = text.length;
    text += (node as Text).data;
    segments.push({ node: node as Text, start, end: text.length });
    previousBlock = block;
  }
  return { text, segments };
}

interface RenderedText extends ReturnType<typeof readText> {
  query?: string;
  ranges?: Map<string, Range>;
}

/** DOM snapshots are weakly owned and invalidated only where observed mutations occur. */
export class FindDomIndex {
  private entries = new WeakMap<Element, { visible?: RenderedText; indexed?: RenderedText }>();

  clear() {
    this.entries = new WeakMap();
  }

  private read(element: Element, includeHidden = false): RenderedText {
    let entry = this.entries.get(element);
    if (!entry) {
      entry = {};
      this.entries.set(element, entry);
    }
    const kind = includeHidden ? "indexed" : "visible";
    entry[kind] ??= readText(element, includeHidden);
    return entry[kind];
  }

  target(element: Element, key: string): FindTarget {
    return { key, text: this.read(element, Boolean(element.closest("[data-find-index]"))).text };
  }

  range(element: Element, match: FindMatch, query: string, cache = true): Range | undefined {
    if (element.closest("[hidden]")) return;
    const source = this.read(element);
    if (source.query !== query) {
      source.query = query;
      source.ranges = new Map();
    }
    const key = `${match.start}:${match.end}`;
    const cached = source.ranges?.get(key);
    if (cached) return cached;
    // Locate both boundaries without walking the full text again for every occurrence.
    const boundary = (offset: number, end: boolean) => {
      let lo = 0,
        hi = source.segments.length;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (end ? source.segments[mid].end < offset : source.segments[mid].end <= offset) lo = mid + 1;
        else hi = mid;
      }
      return source.segments[lo];
    };
    const start = boundary(match.start, false),
      end = boundary(match.end, true);
    if (!start || !end || match.start < start.start || match.end < end.start) return;
    const range = element.ownerDocument.createRange();
    range.setStart(start.node, match.start - start.start);
    range.setEnd(end.node, match.end - end.start);
    if (cache) source.ranges?.set(key, range);
    return range;
  }

  invalidate(records: readonly MutationRecord[]) {
    const subtree = (node: Node) => {
      if (!(node instanceof Element)) return;
      this.entries.delete(node);
      for (const child of node.querySelectorAll("[data-find-key],[data-line]")) this.entries.delete(child);
    };
    for (const record of records) {
      // A replaced child invalidates its indexed ancestors; moved content also changes visibility context.
      for (let node: Node | null = record.target; node; node = node.parentNode)
        if (node instanceof Element) this.entries.delete(node);
      if (record.type === "attributes") subtree(record.target);
      else if (record.type === "childList") {
        for (const node of record.addedNodes) subtree(node);
        for (const node of record.removedNodes) subtree(node);
      }
    }
  }
}

export function mountedFindElements(root: HTMLElement): Map<string, Element[]> {
  const elements = new Map<string, Element[]>();
  const add = (key: string, element: Element) => {
    const nodes = elements.get(key);
    if (nodes) nodes.push(element);
    else elements.set(key, [element]);
  };
  for (const element of root.querySelectorAll<HTMLElement>("[data-find-key]"))
    add(element.dataset.findKey as string, element);
  for (const entry of root.querySelectorAll<HTMLElement>("[data-diff-id]"))
    for (const host of entry.querySelectorAll("diffs-container"))
      for (const line of host.shadowRoot?.querySelectorAll<HTMLElement>("[data-code] [data-line]") ?? [])
        add(`${entry.dataset.diffId}:${line.dataset.lineIndex?.split(",")[0]}`, line);
  return elements;
}
