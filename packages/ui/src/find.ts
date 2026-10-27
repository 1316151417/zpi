export const findTextBlockTags = ["p", "li", "pre", "h1", "h2", "h3", "h4", "h5", "h6", "tr"] as const;

export interface FindRequest {
  query: string;
  activeIndex: number;
  navigationId: number;
  targetRunId?: string;
  matchBefore?: string;
  matchAfter?: string;
}
export interface FindState {
  total: number;
  activeIndex: number;
}
export interface FindTarget {
  key: string;
  text: string;
  path?: string;
  runId?: string;
  /** Some content (streaming or custom diagrams) needs its mounted text instead of a static projection. */
  rendered?: boolean;
}
export interface FindMatch extends FindTarget {
  start: number;
  end: number;
}
export function normalizeFindQuery(query: string): string {
  return query.trim().toLocaleLowerCase();
}
function matchFindTarget(target: FindTarget, needle: string, folded: string) {
  const matches: FindMatch[] = [];
  if (!folded.includes(needle)) return matches;
  const starts: number[] = [],
    ends: number[] = [];
  // Lowercasing can change UTF-16 length (for example İ). Keep DOM offsets in the source text.
  // These offsets are temporary: only the folded text and current matches remain cached.
  if (folded.length !== target.text.length) {
    let offset = 0;
    for (const character of target.text) {
      const lower = character.toLocaleLowerCase();
      for (let i = 0; i < lower.length; i++) {
        starts.push(offset);
        ends.push(offset + character.length);
      }
      offset += character.length;
    }
  }
  let from = 0;
  while (from < folded.length) {
    const start = folded.indexOf(needle, from);
    if (start < 0) break;
    matches.push({
      ...target,
      start: starts[start] ?? start,
      end: ends[start + needle.length - 1] ?? start + needle.length,
    });
    from = start + needle.length;
  }
  return matches;
}
export function buildFindMatches(targets: readonly FindTarget[], query: string): FindMatch[] {
  const needle = normalizeFindQuery(query);
  return needle
    ? targets.flatMap((target) => matchFindTarget(target, needle, target.text.toLocaleLowerCase()))
    : [];
}

/** One current query per loaded target; stable history is not rescanned on streaming updates. */
export class FindIndex {
  private entries = new Map<
    string,
    { target: FindTarget; folded: string; query: string; matches: FindMatch[] }
  >();

  clear() {
    this.entries.clear();
  }

  search(targets: readonly FindTarget[], query: string): FindMatch[] {
    const needle = normalizeFindQuery(query);
    if (!needle) {
      this.clear();
      return [];
    }
    const next: typeof this.entries = new Map();
    const matches: FindMatch[] = [];
    for (const target of targets) {
      let entry = this.entries.get(target.key);
      if (
        !entry ||
        entry.target.text !== target.text ||
        entry.target.path !== target.path ||
        entry.target.runId !== target.runId ||
        entry.target.rendered !== target.rendered
      )
        entry = { target, folded: target.text.toLocaleLowerCase(), query: "", matches: [] };
      if (entry.query !== needle) {
        entry.matches = matchFindTarget(target, needle, entry.folded);
        entry.query = needle;
      }
      next.set(target.key, entry);
      for (const match of entry.matches) matches.push(match);
    }
    this.entries = next;
    return matches;
  }
}
export function findMatchKey(match: FindMatch): string {
  return `${match.key}:${match.start}:${match.end}`;
}
export function moveFindIndex(state: FindState, direction: "previous" | "next"): number {
  if (!state.total) return -1;
  return (state.activeIndex + (direction === "next" ? 1 : -1) + state.total) % state.total;
}
export function findKeyDirection(key: string, shift: boolean): "previous" | "next" | undefined {
  if (key === "ArrowUp" || (key === "Enter" && shift)) return "previous";
  if (key === "ArrowDown" || key === "Enter") return "next";
}

/** Resolve the selected search snippet after older turns finish loading. */
export function findSearchTargetIndex(matches: readonly FindMatch[], request: FindRequest): number {
  if (!request.targetRunId) return -1;
  const normalize = (text: string) =>
    text
      .replace(/[*_`~]/g, "")
      .replace(/\s+/g, " ")
      .toLocaleLowerCase();
  const before = normalize(request.matchBefore ?? "");
  const after = normalize(request.matchAfter ?? "");
  let best = -1;
  let bestScore = -1;
  matches.forEach((match, index) => {
    if (!match.key.startsWith(`${request.targetRunId}:`)) return;
    const left = normalize(match.text.slice(0, match.start));
    const right = normalize(match.text.slice(match.end));
    let score = 0;
    for (let i = 1; i <= before.length && i <= left.length && before.at(-i) === left.at(-i); i++) score++;
    for (let i = 0; i < after.length && i < right.length && after[i] === right[i]; i++) score++;
    if (score > bestScore) {
      best = index;
      bestScore = score;
    }
  });
  return best;
}
