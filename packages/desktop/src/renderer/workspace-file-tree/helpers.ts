export function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
export function replaceSetValue(set: Set<string>, value: string, present: boolean): Set<string> {
  const next = new Set(set);
  if (present) next.add(value);
  else next.delete(value);
  return next;
}
