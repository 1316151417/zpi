// Adapted from ZCode project-sidebar/{view,timelineDates} (Apache-2.0), 3c5b2276.
export interface TaskPreferences {
  organizeBy: "grouped" | "project" | "chronological";
}
export const taskPreferencesKey = "zpi.sidebarTaskPreferences";
export function readTaskPreferences(raw: string | null): TaskPreferences {
  let value: Partial<TaskPreferences> | null = null;
  try {
    value = JSON.parse(raw ?? "null");
  } catch {
    /* Optional preferences. */
  }
  return {
    organizeBy:
      value?.organizeBy === "grouped" || value?.organizeBy === "chronological" ? value.organizeBy : "project",
  };
}
interface TaskTime {
  id: string;
  createdAt: number;
  updatedAt: number;
  running?: boolean;
  status?: string;
}
export function compareTasks(left: TaskTime, right: TaskTime, timeline = false): number {
  if (!timeline && Boolean(left.running) !== Boolean(right.running)) return left.running ? -1 : 1;
  if (!timeline && left.running) return right.createdAt - left.createdAt || right.id.localeCompare(left.id);
  return (
    right.updatedAt - left.updatedAt || right.createdAt - left.createdAt || right.id.localeCompare(left.id)
  );
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
// ZCode timelineDates: use local calendar days, including 23/25-hour DST days.
function calendarDay(at: number): number {
  const date = new Date(at);
  return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 86400000;
}
function timelineKey(at: number, now: number, locale: string) {
  const day = calendarDay(at),
    today = calendarDay(now),
    date = new Date(now);
  const diff = today - day;
  const weekStart = today - ((date.getDay() + (locale === "en-US" ? 0 : 6)) % 7);
  if (diff <= 0) return "today";
  if (diff === 1) return "yesterday";
  if (diff <= 3) return `days:${diff}`;
  if (day >= weekStart) return "thisWeek";
  if (day >= weekStart - 7) return "lastWeek";
  if (day >= calendarDay(new Date(date.getFullYear(), date.getMonth(), 1).getTime())) return "thisMonth";
  if (day >= calendarDay(new Date(date.getFullYear(), date.getMonth() - 1, 1).getTime())) return "lastMonth";
  return "older";
}
export function groupTimelineTasks<T extends Pick<TaskTime, "createdAt" | "updatedAt">>(
  items: T[],
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
    const key = timelineKey(item.updatedAt, now, locale);
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
