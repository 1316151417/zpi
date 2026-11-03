// ZCode's timeline keeps stable height estimates and a mounted live tail (Apache-2.0).
// Normal-flow placeholders keep ZPI's existing history and run navigation anchors usable.
import {
  memo,
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { conversationRunPartition } from "../conversation-run-partition.ts";
import type { RunView } from "../types.ts";

export const historyWindowThreshold = 40;
const estimatedRunHeight = 320;
const retainedTailRuns = 4;

type SavedNodeState = { path: number[]; tag: string; open?: boolean; top?: number; left?: number };
type SavedStates = Map<string, Map<string, SavedNodeState>>;

type Register = (id: string, node: HTMLDivElement | null, measure: () => void) => void;
interface HistoryProps {
  runs: RunView[];
  root: RefObject<HTMLDivElement | null>;
  windowed: boolean;
  initialRunId?: string;
  pinnedRunIds?: ReadonlySet<string>;
  renderRun(run: RunView): ReactNode;
}
interface CachedHistoryProps extends HistoryProps {
  retainedStates: SavedStates;
  measuredHeights: Map<string, number>;
  transitionRunIds?: ReadonlySet<string>;
}

function hasHistoryInteraction(node: HTMLElement, selection = node.ownerDocument.getSelection()): boolean {
  if (node.contains(node.ownerDocument.activeElement) || node.querySelector(".user-message-editor"))
    return true;
  if (selection && !selection.isCollapsed)
    for (let index = 0; index < selection.rangeCount; index++)
      if (selection.getRangeAt(index).intersectsNode(node)) return true;
  return false;
}

const HistoryRun = memo(function HistoryRun({
  run,
  mounted,
  register,
  renderRun,
  retainedStates,
  measuredHeights,
}: {
  run: RunView;
  mounted: boolean;
  register: Register;
  renderRun: HistoryProps["renderRun"];
  retainedStates: SavedStates;
  measuredHeights: Map<string, number>;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const height = useRef(measuredHeights.get(run.runId) ?? estimatedRunHeight);
  let retainedState = retainedStates.get(run.runId);
  if (!retainedState) {
    retainedState = new Map<string, SavedNodeState>();
    retainedStates.set(run.runId, retainedState);
  }
  const measure = useCallback(() => {
    const node = ref.current;
    if (node?.dataset.historyMounted !== "true") return;
    const bounds = node.getBoundingClientRect();
    if (!Number.isFinite(bounds.height) || bounds.height <= 0) return;
    height.current = bounds.height;
    measuredHeights.set(run.runId, bounds.height);
  }, [measuredHeights, run.runId]);
  const bind = useCallback(
    (node: HTMLDivElement | null) => {
      ref.current = node;
      register(run.runId, node, measure);
    },
    [run.runId, register, measure],
  );
  useLayoutEffect(() => {
    if (!mounted || !ref.current) return;
    const root = ref.current;
    for (const saved of retainedState.values()) {
      let node: Element | undefined = root;
      for (const index of saved.path) node = node?.children[index];
      if (!(node instanceof HTMLElement) || node.tagName !== saved.tag) continue;
      if (node instanceof HTMLDetailsElement && saved.open !== undefined) node.open = saved.open;
      if (saved.top !== undefined) node.scrollTop = saved.top;
      if (saved.left !== undefined) node.scrollLeft = saved.left;
    }
    const retain = (event: Event) => {
      const node = event.target;
      if (!(node instanceof HTMLElement) || node === root) return;
      const path: number[] = [];
      for (let current: Element | null = node; current !== root; ) {
        const parent: Element | null = current?.parentElement ?? null;
        if (!parent || !current) return;
        path.unshift(Array.prototype.indexOf.call(parent.children, current));
        current = parent;
      }
      retainedState.set(path.join("/"), {
        path,
        tag: node.tagName,
        ...(node instanceof HTMLDetailsElement
          ? { open: node.open }
          : { top: node.scrollTop, left: node.scrollLeft }),
      });
    };
    root.addEventListener("toggle", retain, true);
    root.addEventListener("scroll", retain, true);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(ref.current);
    return () => {
      observer.disconnect();
      root.removeEventListener("toggle", retain, true);
      root.removeEventListener("scroll", retain, true);
    };
  }, [mounted, measure, retainedState]);
  return (
    <div
      ref={bind}
      data-history-run={run.runId}
      data-history-mounted={mounted}
      style={mounted ? undefined : { height: height.current }}
    >
      {mounted ? renderRun(run) : null}
    </div>
  );
});

const WindowedHistory = memo(function WindowedHistory({
  runs,
  root,
  windowed,
  initialRunId,
  pinnedRunIds,
  renderRun,
  retainedStates,
  measuredHeights,
}: CachedHistoryProps) {
  const nodes = useRef(new Map<string, { node: HTMLDivElement; measure: () => void }>());
  const observer = useRef<IntersectionObserver | null>(null);
  const intersecting = useRef(new Set<string>());
  const [visible, setVisible] = useState(() => {
    const index = runs.findIndex((run) => run.runId === initialRunId);
    return new Set(index < 0 ? [] : runs.slice(Math.max(0, index - 4), index + 5).map((run) => run.runId));
  });
  const mounted = useRef(new Set<string>());
  const wasWindowed = useRef(windowed);
  const register = useCallback<Register>((id, node, measure) => {
    const previous = nodes.current.get(id);
    if (previous) observer.current?.unobserve(previous.node);
    if (node) {
      nodes.current.set(id, { node, measure });
      observer.current?.observe(node);
    } else {
      nodes.current.delete(id);
      intersecting.current.delete(id);
    }
  }, []);
  useEffect(() => {
    // 父级滚动容器的 ref 在子组件 layout effect 之后才挂好，必须等提交完成再观察。
    const scroll = root.current;
    if (!windowed || !scroll) return;
    const update = () => {
      const next = new Set(intersecting.current);
      const selection = scroll.ownerDocument.getSelection();
      for (const id of mounted.current) {
        const node = nodes.current.get(id)?.node;
        if (!node) continue;
        if (hasHistoryInteraction(node, selection)) next.add(id);
      }
      setVisible((current) =>
        current.size === next.size && [...next].every((id) => current.has(id)) ? current : next,
      );
    };
    const intersection = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const id = (entry.target as HTMLElement).dataset.historyRun;
          if (!id) continue;
          if (entry.isIntersecting) intersecting.current.add(id);
          else {
            nodes.current.get(id)?.measure();
            intersecting.current.delete(id);
          }
        }
        update();
      },
      { root: scroll, rootMargin: "1200px 0px" },
    );
    observer.current = intersection;
    for (const { node } of nodes.current.values()) intersection.observe(node);
    scroll.ownerDocument.addEventListener("selectionchange", update);
    scroll.ownerDocument.addEventListener("focusin", update);
    scroll.ownerDocument.addEventListener("focusout", update);
    return () => {
      intersection.disconnect();
      observer.current = null;
      intersecting.current.clear();
      scroll.ownerDocument.removeEventListener("selectionchange", update);
      scroll.ownerDocument.removeEventListener("focusin", update);
      scroll.ownerDocument.removeEventListener("focusout", update);
    };
  }, [root, windowed]);
  const partition = conversationRunPartition(runs);
  const renderHistory = useMemo(() => {
    const retained = new Set<string>();
    const rows = partition.history.map((run, index) => {
      const show =
        !windowed ||
        run.status === "running" ||
        index >= runs.length - retainedTailRuns ||
        (!wasWindowed.current && mounted.current.has(run.runId)) ||
        visible.has(run.runId) ||
        pinnedRunIds?.has(run.runId) === true;
      if (show) retained.add(run.runId);
      return (
        <HistoryRun
          key={run.runId}
          run={run}
          mounted={show}
          register={register}
          renderRun={renderRun}
          retainedStates={retainedStates}
          measuredHeights={measuredHeights}
        />
      );
    });
    return { rows, retained };
  }, [
    partition.history,
    windowed,
    visible,
    pinnedRunIds,
    register,
    renderRun,
    runs.length,
    retainedStates,
    measuredHeights,
  ]);
  const nextMounted = new Set(renderHistory.retained);
  const tail = partition.tail;
  if (tail) nextMounted.add(tail.runId);
  useLayoutEffect(() => {
    mounted.current = nextMounted;
    wasWindowed.current = windowed;
  });
  return [
    ...renderHistory.rows,
    tail && (
      <HistoryRun
        key={tail.runId}
        run={tail}
        mounted
        register={register}
        renderRun={renderRun}
        retainedStates={retainedStates}
        measuredHeights={measuredHeights}
      />
    ),
  ];
});

// Large histories retain one lightweight placeholder per chunk instead of one per run.
// Existing small histories keep their established per-run anchoring behavior.
const historyChunkSize = 64;
const chunkThreshold = 256;
type HistoryGroup = { key: string; runs: RunView[] };

export function historyChunkForRun(root: HTMLElement, index: number): HTMLElement | undefined {
  return Array.from(root.querySelectorAll<HTMLElement>("[data-history-chunk]")).find(
    (node) => index >= Number(node.dataset.historyStart) && index < Number(node.dataset.historyEnd),
  );
}

// Keep existing group identities when pagination prepends or a new turn appends.
// Repartitioning every group would remount selected text and focused controls.
function groupHistory(
  runs: readonly RunView[],
  previous: { runs: readonly RunView[]; groups: HistoryGroup[] },
) {
  const start = previous.runs.length ? runs.findIndex((run) => run.runId === previous.runs[0].runId) : -1;
  const extendsPrevious =
    start >= 0 && previous.runs.every((run, index) => runs[start + index]?.runId === run.runId);
  const sliceGroups = (items: readonly RunView[]) => {
    const groups: HistoryGroup[] = [];
    for (let index = 0; index < items.length; index += historyChunkSize)
      groups.push({ key: items[index].runId, runs: items.slice(index, index + historyChunkSize) });
    return groups;
  };
  if (!extendsPrevious) return sliceGroups(runs);
  let offset = start;
  const groups = previous.groups.map((group) => {
    const next = { key: group.key, runs: runs.slice(offset, offset + group.runs.length) };
    offset += group.runs.length;
    return next;
  });
  const prefix = runs.slice(0, start);
  const first = groups[0];
  const prependCount = Math.min(prefix.length, historyChunkSize - first.runs.length);
  first.runs.unshift(...prefix.slice(prefix.length - prependCount));
  const suffix = runs.slice(offset);
  const last = groups[groups.length - 1];
  const appendCount = Math.min(suffix.length, historyChunkSize - last.runs.length);
  last.runs.push(...suffix.slice(0, appendCount));
  return [
    ...sliceGroups(prefix.slice(0, prefix.length - prependCount)),
    ...groups,
    ...sliceGroups(suffix.slice(appendCount)),
  ];
}

const HistoryChunk = memo(function HistoryChunk({
  runs,
  root,
  initialRunId,
  pinnedRunIds,
  renderRun,
  index,
  start,
  live,
  retainedStates,
  measuredHeights,
  transitionRunIds,
}: CachedHistoryProps & { index: number; start: number; live: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const height = useRef(
    runs.reduce((total, run) => total + (measuredHeights.get(run.runId) ?? estimatedRunHeight), 0),
  );
  const previousCount = useRef(runs.length);
  if (previousCount.current !== runs.length) {
    height.current = runs.reduce(
      (total, run) => total + (measuredHeights.get(run.runId) ?? estimatedRunHeight),
      0,
    );
    previousCount.current = runs.length;
  }
  const [observed, setObserved] = useState(false);
  const [near, setNear] = useState(false);
  const [interaction, setInteraction] = useState(false);
  const forced =
    live ||
    runs.some(
      (run) =>
        run.status === "running" ||
        run.runId === initialRunId ||
        pinnedRunIds?.has(run.runId) ||
        (!observed && transitionRunIds?.has(run.runId)),
    );
  const active = near || interaction || forced;
  const pinned = useMemo(
    () =>
      !observed && transitionRunIds ? new Set([...(pinnedRunIds ?? []), ...transitionRunIds]) : pinnedRunIds,
    [observed, transitionRunIds, pinnedRunIds],
  );
  useEffect(() => {
    const node = ref.current;
    const scroll = root.current;
    if (!node || !scroll) return;
    const observer = new IntersectionObserver(
      (entries) => {
        setNear(entries.some((entry) => entry.isIntersecting));
        setObserved(true);
      },
      { root: scroll, rootMargin: "1200px 0px" },
    );
    observer.observe(node);
    const update = () => setInteraction(hasHistoryInteraction(node));
    node.ownerDocument.addEventListener("selectionchange", update);
    node.ownerDocument.addEventListener("focusin", update);
    node.ownerDocument.addEventListener("focusout", update);
    return () => {
      observer.disconnect();
      node.ownerDocument.removeEventListener("selectionchange", update);
      node.ownerDocument.removeEventListener("focusin", update);
      node.ownerDocument.removeEventListener("focusout", update);
    };
  }, [root]);
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node || !active) return;
    const measure = () => {
      const value = node.getBoundingClientRect().height;
      if (value > 0) height.current = value;
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => {
      measure();
      observer.disconnect();
    };
  }, [active]);
  useLayoutEffect(() => {
    root.current?.dispatchEvent(new Event("zpi-history-window"));
  }, [active, root]);
  return (
    <div
      ref={ref}
      data-history-chunk={index}
      data-history-start={start}
      data-history-end={start + runs.length}
      style={active ? undefined : { height: height.current, overflowAnchor: "none" }}
    >
      {active && (
        <WindowedHistory
          runs={runs}
          root={root}
          windowed
          initialRunId={initialRunId}
          pinnedRunIds={pinned}
          renderRun={renderRun}
          retainedStates={retainedStates}
          measuredHeights={measuredHeights}
        />
      )}
    </div>
  );
});

export const ConversationHistory = memo(function ConversationHistory(props: HistoryProps) {
  const { runs, windowed } = props;
  const [layoutLocked, setLayoutLocked] = useState(false);
  const chunked = useRef(false);
  useEffect(() => {
    const root = props.root.current;
    if (!root) return;
    const update = () => setLayoutLocked(hasHistoryInteraction(root));
    update();
    root.ownerDocument.addEventListener("selectionchange", update);
    root.ownerDocument.addEventListener("focusin", update);
    root.ownerDocument.addEventListener("focusout", update);
    return () => {
      root.ownerDocument.removeEventListener("selectionchange", update);
      root.ownerDocument.removeEventListener("focusin", update);
      root.ownerDocument.removeEventListener("focusout", update);
    };
  }, [props.root]);
  const layoutAnchor = useRef<{ id: string; top: number } | null>(null);
  const nextChunked = layoutLocked ? chunked.current : windowed && runs.length >= chunkThreshold;
  if (nextChunked !== chunked.current) {
    const root = props.root.current;
    const top = root?.getBoundingClientRect().top ?? 0;
    const anchor = Array.from(
      root?.querySelectorAll<HTMLElement>('[data-history-mounted="true"]') ?? [],
    ).find((node) => node.getBoundingClientRect().bottom > top);
    layoutAnchor.current = anchor?.dataset.historyRun
      ? { id: anchor.dataset.historyRun, top: anchor.getBoundingClientRect().top }
      : null;
    chunked.current = nextChunked;
  }
  useLayoutEffect(() => {
    const root = props.root.current;
    const anchor = layoutAnchor.current;
    layoutAnchor.current = null;
    if (!root || !anchor) return;
    const node = Array.from(root.querySelectorAll<HTMLElement>("[data-history-run]")).find(
      (node) => node.dataset.historyRun === anchor.id,
    );
    if (node) root.scrollTop += node.getBoundingClientRect().top - anchor.top;
  });
  const partition = conversationRunPartition(runs);
  const savedStates = useRef<SavedStates>(new Map());
  const heights = useRef(new Map<string, number>());
  const transitionRunIds = useMemo(
    () =>
      new Set(
        Array.from(
          props.root.current?.querySelectorAll<HTMLElement>('[data-history-mounted="true"]') ?? [],
        ).map((node) => node.dataset.historyRun ?? ""),
      ),
    [partition.history, props.root],
  );
  const shared = {
    ...props,
    retainedStates: savedStates.current,
    measuredHeights: heights.current,
    transitionRunIds,
  };
  const previousGroups = useRef<{ runs: readonly RunView[]; groups: HistoryGroup[] }>({
    runs: [],
    groups: [],
  });
  const historyChunks = useMemo(() => {
    const groups = groupHistory(partition.history, previousGroups.current);
    previousGroups.current = { runs: partition.history, groups };
    return groups;
  }, [partition.history]);
  const chunks = useMemo(() => {
    const groups = [...historyChunks];
    if (partition.tail) {
      if (groups.length && groups[groups.length - 1].runs.length < historyChunkSize) {
        const last = groups[groups.length - 1];
        groups[groups.length - 1] = { ...last, runs: [...last.runs, partition.tail] };
      } else groups.push({ key: partition.tail.runId, runs: [partition.tail] });
    }
    return groups;
  }, [historyChunks, partition.tail]);
  if (!chunked.current) return <WindowedHistory {...shared} />;
  let start = 0;
  return (
    <>
      {chunks.map((group, index) => {
        const first = start;
        start += group.runs.length;
        return (
          <HistoryChunk
            {...shared}
            key={group.key}
            runs={group.runs}
            index={index}
            start={first}
            live={index === chunks.length - 1}
          />
        );
      })}
    </>
  );
});
