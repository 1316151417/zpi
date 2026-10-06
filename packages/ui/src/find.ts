export interface FindRequest {
  query: string;
  activeIndex: number;
  navigationId: number;
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
