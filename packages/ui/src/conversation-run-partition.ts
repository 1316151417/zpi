import type { RunView } from "./types.ts";

/** Renderer-only cache; both slices always describe exactly the supplied immutable array. */
export interface ConversationRunPartition {
  history: readonly RunView[];
  tail?: RunView;
}
const partitions = new WeakMap<readonly RunView[], ConversationRunPartition>();

export function conversationRunPartition(runs: readonly RunView[]): ConversationRunPartition {
  let partition = partitions.get(runs);
  if (!partition) {
    partition = { history: runs.slice(0, -1), tail: runs.at(-1) };
    partitions.set(runs, partition);
  }
  return partition;
}

/** A normal stream delta changes just the final run; preserve the cached history slice. */
export function advanceConversationRunPartition(
  previous: readonly RunView[],
  next: readonly RunView[],
  changedIndex: number,
): void {
  const cached = partitions.get(previous);
  if (!cached || previous.length !== next.length || changedIndex !== next.length - 1) return;
  partitions.set(next, { history: cached.history, tail: next.at(-1) });
}

export function isNavigableRun(run: RunView): boolean {
  return (
    !run.historyContinuation &&
    !run.subagentNotification &&
    run.kind !== "compact" &&
    Boolean(run.userMessage.trim() || run.attachments?.length)
  );
}

export interface ConversationQuery {
  key: string;
  run: RunView;
  text: string;
}
export function conversationQueries(run: RunView): ConversationQuery[] {
  const queries: ConversationQuery[] = isNavigableRun(run)
    ? [{ key: `${run.runId}:user`, run, text: run.userMessage }]
    : [];
  for (const guide of run.guides ?? [])
    queries.push({ key: `${run.runId}:guide:${guide.id}`, run, text: guide.text });
  return queries;
}
