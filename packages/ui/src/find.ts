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
}
export interface FindMatch extends FindTarget {
  start: number;
  end: number;
}
export function normalizeFindQuery(query: string): string {
  return query.trim().toLocaleLowerCase();
}
export function buildFindMatches(targets: readonly FindTarget[], query: string): FindMatch[] {
  const needle = normalizeFindQuery(query);
  if (!needle) return [];
  const matches: FindMatch[] = [];
  for (const target of targets) {
    // Lowercasing can change UTF-16 length (for example İ). Keep DOM offsets in the source text.
    const folded = target.text.toLocaleLowerCase();
    if (!folded.includes(needle)) continue;
    const starts: number[] = [],
      ends: number[] = [];
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
  }
  return matches;
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
