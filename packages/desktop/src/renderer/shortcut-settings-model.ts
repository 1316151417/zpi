import { formatShortcut, normalizeShortcut, shortcutLabelParts } from "../shared/shortcuts.ts";

export const shortcutScopeLabels = {
  global: ["系统全局", "应用在后台时也可使用"],
  app: ["应用内", "工作区内可用；设置及其他浮层打开时暂停"],
  composer: ["输入框", "当前任务或辅助对话的消息输入框"],
  "draft-composer": ["新任务输入框", "具有 Git 本地环境的新任务输入框"],
  task: ["任务面板", "已有任务的工作区，打开顶部三点菜单"],
} as const;

function searchText(value: string): string {
  return value
    .toLowerCase()
    .replace(/command|cmd|meta|⌘/g, "command")
    .replace(/control|ctrl|⌃/g, "control")
    .replace(/option|alt|⌥/g, "alt")
    .replace(/shift|⇧/g, "shift")
    .replace(/[\s+]/g, "");
}

export function matchesShortcutSearch(
  label: string,
  binding: string | null,
  query: string,
  key: string | null,
  platform: string,
): boolean {
  if (key && (!binding || normalizeShortcut(binding, platform) !== key)) return false;
  const keyword = searchText(query.trim());
  return (
    !keyword ||
    [
      label,
      binding ?? "未设置",
      formatShortcut(binding, platform),
      shortcutLabelParts(binding, platform).join(" "),
    ].some((text) => searchText(text).includes(keyword))
  );
}
