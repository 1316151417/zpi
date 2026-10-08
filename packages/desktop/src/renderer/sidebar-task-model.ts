// Ported from ZCode taskListOrdering, taskListItemPresentation, taskTimelineGroups,
// sidebarTaskPreferences and workspaceTaskPagination (Apache-2.0), 872ad960.
export type TaskSortBy = "created" | "updated";
export interface TaskPreferences {
  organizeBy: "project" | "chronological";
  sortBy: TaskSortBy;
}
export const taskPreferencesKey = "ZPI.sidebarTaskPreferences";
export function readTaskPreferences(raw: string | null): TaskPreferences {
  let value: Partial<TaskPreferences> | null = null;
  try {
    value = JSON.parse(raw ?? "null");
  } catch {
    /* Optional preferences. */
  }
  return {
    organizeBy: value?.organizeBy === "chronological" ? "chronological" : "project",
    sortBy: value?.sortBy === "created" ? "created" : "updated",
  };
}
interface TaskTime {
  id: string;
  createdAt: number;
  updatedAt: number;
  running?: boolean;
  status?: string;
}
export function compareTasks(left: TaskTime, right: TaskTime, by: TaskSortBy): number {
  if (Boolean(left.running) !== Boolean(right.running)) return left.running ? -1 : 1;
  if (left.running) return right.createdAt - left.createdAt || right.id.localeCompare(left.id);
  return by === "created"
    ? right.createdAt - left.createdAt || right.updatedAt - left.updatedAt || right.id.localeCompare(left.id)
    : right.updatedAt - left.updatedAt || right.createdAt - left.createdAt || right.id.localeCompare(left.id);
}
export function formatTaskRelativeTime(timestamp: number, now = Date.now(), locale = "zh-CN"): string {
  const minutes = Math.floor((now - timestamp) / 60000);
  if (minutes < 1) return locale === "en-US" ? "now" : "刚刚";
  if (minutes < 60) return `${minutes}${locale === "en-US" ? "m" : "分"}`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}${locale === "en-US" ? "h" : "小时"}`;
  return `${Math.floor(hours / 24)}${locale === "en-US" ? "d" : "天"}`;
}
export function taskPage<T>(
  items: T[],
  limit: number,
  state?: { hasMore: boolean; total: number; loading: boolean },
) {
  const visible = items.slice(0, limit);
  const knownMore = Boolean(state?.hasMore) || (state?.total ?? items.length) > visible.length;
  return { items: visible, hasMore: state?.loading ? knownMore : items.length >= limit && knownMore };
}
export function retainProjectLimits(limits: Record<string, number>, visible: ReadonlySet<string>) {
  const entries = Object.entries(limits).filter(([key]) => visible.has(key));
  return entries.length === Object.keys(limits).length ? limits : Object.fromEntries(entries);
}
const dayMs = 86400000;
function startOfDay(at: number) {
  const d = new Date(at);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}
function timelineKey(at: number, now: number, locale: string) {
  const day = startOfDay(at),
    today = startOfDay(now);
  const diff = Math.floor((today - day) / dayMs);
  if (diff <= 0) return "today";
  if (diff === 1) return "yesterday";
  if (diff <= 3) return `days:${diff}`;
  const week = new Date(today);
  week.setDate(week.getDate() - ((week.getDay() - (locale === "en-US" ? 0 : 1) + 7) % 7));
  if (day >= week.getTime()) return "thisWeek";
  if (day >= week.getTime() - 7 * dayMs) return "lastWeek";
  const d = new Date(now);
  if (day >= new Date(d.getFullYear(), d.getMonth(), 1).getTime()) return "thisMonth";
  if (day >= new Date(d.getFullYear(), d.getMonth() - 1, 1).getTime()) return "lastMonth";
  return "older";
}
export function groupTimelineTasks<T extends Pick<TaskTime, "createdAt" | "updatedAt">>(
  items: T[],
  by: TaskSortBy,
  now = Date.now(),
  locale = "zh-CN",
) {
  const labels: Record<string, string> =
    locale === "en-US"
      ? {
          today: "Today",
          yesterday: "Yesterday",
          thisWeek: "This week",
          lastWeek: "Last week",
          thisMonth: "This month",
          lastMonth: "Last month",
          older: "Older",
        }
      : {
          today: "今天",
          yesterday: "昨天",
          thisWeek: "本周",
          lastWeek: "上周",
          thisMonth: "本月",
          lastMonth: "上月",
          older: "更早",
        };
  const groups = new Map<string, { key: string; label: string; items: T[] }>();
  for (const item of items) {
    const key = timelineKey(by === "created" ? item.createdAt : item.updatedAt, now, locale);
    let group = groups.get(key);
    if (!group) {
      group = {
        key,
        label: labels[key] ?? `${key.slice(5)} ${locale === "en-US" ? "days ago" : "天前"}`,
        items: [],
      };
      groups.set(key, group);
    }
    group.items.push(item);
  }
  return [...groups.values()];
}
