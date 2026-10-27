// ZCode's timeline keeps stable height estimates and a mounted live tail (Apache-2.0).
// Normal-flow placeholders keep ZPI's existing history and run navigation anchors usable.
import {
  memo,
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { RunView } from "../types.ts";

export const historyWindowThreshold = 40;
const estimatedRunHeight = 320;
const retainedTailRuns = 4;

type Register = (id: string, node: HTMLDivElement | null, measure: () => void) => void;
interface HistoryProps {
  runs: RunView[];
  root: RefObject<HTMLDivElement | null>;
  windowed: boolean;
  initialRunId?: string;
  pinnedRunIds?: ReadonlySet<string>;
  renderRun(run: RunView): ReactNode;
}

const HistoryRun = memo(function HistoryRun({
  run,
  mounted,
  register,
  renderRun,
}: {
  run: RunView;
  mounted: boolean;
  register: Register;
  renderRun: HistoryProps["renderRun"];
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const height = useRef(estimatedRunHeight);
  const retainedState = useRef(
    new Map<string, { path: number[]; tag: string; open?: boolean; top?: number; left?: number }>(),
  );
  const measure = useCallback(() => {
    const node = ref.current;
    if (node?.dataset.historyMounted !== "true") return;
    const bounds = node.getBoundingClientRect();
    if (!Number.isFinite(bounds.height) || bounds.height <= 0) return;
    height.current = bounds.height;
  }, []);
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
    for (const saved of retainedState.current.values()) {
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
      retainedState.current.set(path.join("/"), {
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
  }, [mounted, measure]);
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

export const ConversationHistory = memo(function ConversationHistory({
  runs,
  root,
  windowed,
  initialRunId,
  pinnedRunIds,
  renderRun,
}: HistoryProps) {
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
        let pinned =
          node.contains(scroll.ownerDocument.activeElement) || !!node.querySelector(".user-message-editor");
        if (selection && !selection.isCollapsed)
          for (let i = 0; i < selection.rangeCount && !pinned; i++)
            pinned = selection.getRangeAt(i).intersectsNode(node);
        if (pinned) next.add(id);
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
  const nextMounted = new Set<string>();
  const rows = runs.map((run, index) => {
    const show =
      !windowed ||
      run.status === "running" ||
      index >= runs.length - retainedTailRuns ||
      // 跨过分页阈值时，先让旧可见内容提交真实高度，再由观察器裁剪，保留补齐用户前缀的高度差。
      (!wasWindowed.current && mounted.current.has(run.runId)) ||
      visible.has(run.runId);
    const retained = show || pinnedRunIds?.has(run.runId) === true;
    if (retained) nextMounted.add(run.runId);
    return (
      <HistoryRun key={run.runId} run={run} mounted={retained} register={register} renderRun={renderRun} />
    );
  });
  useLayoutEffect(() => {
    mounted.current = nextMounted;
    wasWindowed.current = windowed;
  });
  return rows;
});
