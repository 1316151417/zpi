export const taskGroupCollapsedKey = "zpi.collapsedTaskGroups";
export function parseCollapsedTaskGroups(raw: string | null): string[] {
  try {
    const value: unknown = JSON.parse(raw ?? "[]");
    return Array.isArray(value)
      ? [...new Set(value.filter((id): id is string => typeof id === "string"))]
      : [];
  } catch {
    return [];
  }
}
export function pruneCollapsedTaskGroups(
  current: string[],
  groupIds: readonly string[],
  hydrated: boolean,
): string[] {
  if (!hydrated) return current;
  const next = current.filter((id) => groupIds.includes(id));
  return next.length === current.length ? current : next;
}
