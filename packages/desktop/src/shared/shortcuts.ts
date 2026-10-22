/** The same accelerator grammar is used by settings, DOM events and Electron. */
export const shortcutCommands = [
  { id: "toggle-window", label: "显示或隐藏窗口", scope: "global" },
  { id: "quick-chat", label: "快速对话", scope: "global" },
  { id: "quick-chat-new", label: "新建快速对话", scope: "global" },
  { id: "quick-chat-screenshot", label: "截图带入快速对话", scope: "global" },
  { id: "quick-chat-selection", label: "复制选中文字并带入快速对话", scope: "global" },
  { id: "quick-chat-clipboard", label: "剪贴板带入快速对话", scope: "global" },
  { id: "toggle-sidebar", label: "显示或隐藏左侧栏", scope: "app" },
  { id: "pane-full-view", label: "进入或退出完整视图", scope: "app" },
  { id: "toggle-pane", label: "显示或隐藏右侧面板", scope: "app" },
  { id: "focus-composer", label: "聚焦任务输入框", scope: "app" },
  { id: "send-next", label: "立即发送消息", scope: "composer" },
  { id: "configure-environment", label: "配置本地环境", scope: "draft-composer" },
  { id: "select-model", label: "选择模型", scope: "composer" },
  { id: "task-menu", label: "打开或关闭任务菜单", scope: "task" },
  { id: "pin-1", label: "切换到置顶任务 1", scope: "app" },
  { id: "pin-2", label: "切换到置顶任务 2", scope: "app" },
  { id: "pin-3", label: "切换到置顶任务 3", scope: "app" },
  { id: "pin-4", label: "切换到置顶任务 4", scope: "app" },
  { id: "pin-5", label: "切换到置顶任务 5", scope: "app" },
  { id: "new-task", label: "新建任务", scope: "app" },
  { id: "search", label: "搜索任务", scope: "app" },
  { id: "find", label: "查找当前对话", scope: "app" },
  { id: "stop-run", label: "停止当前回复", scope: "app" },
] as const;
export type ShortcutCommand = (typeof shortcutCommands)[number]["id"];
export type GlobalShortcutCommand = Extract<(typeof shortcutCommands)[number], { scope: "global" }>["id"];
export interface ShortcutSettings {
  enabled: boolean;
  bindings: Record<ShortcutCommand, string | null>;
}
export interface ShortcutKeyEvent {
  key: string;
  code?: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  repeat?: boolean;
  isComposing?: boolean;
}
const modifiers = ["Control", "Alt", "Shift", "Command"] as const;
const aliases: Record<string, string> = {
  ctrl: "Control",
  control: "Control",
  alt: "Alt",
  option: "Alt",
  shift: "Shift",
  cmd: "Command",
  command: "Command",
  meta: "Command",
  super: "Command",
  esc: "Escape",
  escape: "Escape",
  return: "Enter",
  enter: "Enter",
  space: "Space",
  tab: "Tab",
  backspace: "Backspace",
  delete: "Delete",
  del: "Delete",
  insert: "Insert",
  home: "Home",
  end: "End",
  pageup: "PageUp",
  pagedown: "PageDown",
  up: "Up",
  arrowup: "Up",
  down: "Down",
  arrowdown: "Down",
  left: "Left",
  arrowleft: "Left",
  right: "Right",
  arrowright: "Right",
  plus: "Plus",
};
const punctuation: Record<string, string> = {
  Backquote: "`",
  Minus: "-",
  Equal: "=",
  BracketLeft: "[",
  BracketRight: "]",
  Backslash: "\\",
  Semicolon: ";",
  Quote: "'",
  Comma: ",",
  Period: ".",
  Slash: "/",
};
function keyName(value: string): string | undefined {
  const alias = aliases[value.toLowerCase()];
  if (alias) return alias;
  if (/^[a-z0-9]$/i.test(value)) return value.toUpperCase();
  if (/^F(?:[1-9]|1\d|2[0-4])$/i.test(value)) return value.toUpperCase();
  if (Object.values(punctuation).includes(value)) return value;
  return undefined;
}
export function normalizeShortcut(binding: string, platform: string): string | undefined {
  if (typeof binding !== "string" || binding.length > 100) return undefined;
  const parts = binding
    .trim()
    .split("+")
    .map((part) => part.trim());
  if (parts.length === 0 || parts.some((part) => !part)) return undefined;
  const held = new Set<string>();
  let key: string | undefined;
  for (const part of parts) {
    const normalized = /^(cmdorctrl|commandorcontrol)$/i.test(part)
      ? platform === "darwin"
        ? "Command"
        : "Control"
      : keyName(part);
    if (!normalized) return undefined;
    if ((modifiers as readonly string[]).includes(normalized)) {
      if (held.has(normalized) || key) return undefined;
      held.add(normalized);
    } else {
      if (key) return undefined;
      key = normalized;
    }
  }
  return key ? [...modifiers.filter((modifier) => held.has(modifier)), key].join("+") : undefined;
}
export function defaultShortcuts(platform: string): ShortcutSettings {
  const primary = platform === "darwin" ? "Command" : "Control";
  return {
    enabled: true,
    bindings: {
      "toggle-window": platform === "darwin" ? "Control+Command+E" : "Control+Alt+E",
      "quick-chat": platform === "darwin" ? "Alt+Space" : "Alt+N",
      "quick-chat-new": platform === "darwin" ? "Alt+Shift+Space" : "Alt+Shift+N",
      "quick-chat-screenshot": platform === "darwin" ? "Alt+Shift+A" : null,
      "quick-chat-selection": platform === "darwin" ? "Alt+Shift+C" : null,
      "quick-chat-clipboard": platform === "darwin" ? "Alt+Shift+V" : null,
      "toggle-sidebar": `${primary}+[`,
      "toggle-pane": `${primary}+]`,
      "pane-full-view": platform === "darwin" ? "Shift+Command+F" : "Control+Shift+F",
      "focus-composer": `${primary}+I`,
      "send-next": `${primary}+Enter`,
      "configure-environment": `${primary}+J`,
      "select-model": `${primary}+L`,
      "task-menu": `${primary}+U`,
      "pin-1": `${primary}+1`,
      "pin-2": `${primary}+2`,
      "pin-3": `${primary}+3`,
      "pin-4": `${primary}+4`,
      "pin-5": `${primary}+5`,
      "new-task": `${primary}+N`,
      search: `${primary}+K`,
      find: `${primary}+F`,
      "stop-run": "Escape",
    },
  };
}
/** Returns a recordable accelerator; validation explains any reserved combination. */
export function shortcutFromEvent(
  event: ShortcutKeyEvent,
  platform: string,
  allowAltLetter = false,
): string | null {
  // Option+N is a dead key on macOS; quick-chat recording still uses the physical letter.
  const altLetter = allowAltLetter && event.altKey && /^Key[A-Z]$/.test(event.code ?? "");
  if (
    event.isComposing ||
    event.repeat ||
    ["Process", "Unidentified"].includes(event.key) ||
    (event.key === "Dead" && !altLetter)
  )
    return null;
  let key: string | undefined;
  if (/^Key[A-Z]$/.test(event.code ?? "")) key = event.code?.slice(3);
  else if (/^Digit\d$/.test(event.code ?? "")) key = event.code?.slice(5);
  else if (event.code === "Space") key = "Space";
  else if (event.code && Object.hasOwn(punctuation, event.code)) key = punctuation[event.code];
  else key = event.key === " " ? "Space" : event.key === "+" ? "Plus" : keyName(event.key);
  if (!key || (modifiers as readonly string[]).includes(key)) return null;
  return (
    normalizeShortcut(
      [
        ...(event.ctrlKey ? ["Control"] : []),
        ...(event.altKey ? ["Alt"] : []),
        ...(event.shiftKey ? ["Shift"] : []),
        ...(event.metaKey ? ["Command"] : []),
        key,
      ].join("+"),
      platform,
    ) ?? null
  );
}
export function shortcutForEvent(
  event: ShortcutKeyEvent,
  platform: string,
  settings: ShortcutSettings,
): ShortcutCommand | undefined {
  if (!settings.enabled) return undefined;
  const binding = shortcutFromEvent(event, platform, true);
  if (!binding) return undefined;
  return shortcutCommands.find(({ id }) => {
    const saved = settings.bindings[id];
    return (
      (event.key !== "Dead" || id.startsWith("quick-chat")) &&
      saved !== null &&
      normalizeShortcut(saved, platform) === binding
    );
  })?.id;
}
export function shortcutLabelParts(binding: string | null, platform: string): string[] {
  if (binding === null) return ["未设置"];
  const normalized = normalizeShortcut(binding, platform);
  if (!normalized) return [binding];
  const symbols: Record<string, string> =
    platform === "darwin"
      ? { Control: "⌃", Alt: "⌥", Shift: "⇧", Command: "⌘", Enter: "↵", Escape: "Esc", Space: "Space" }
      : { Control: "Ctrl", Command: "Win", Escape: "Esc", Plus: "+" };
  return normalized.split("+").map((key) => symbols[key] ?? key);
}
export function formatShortcut(binding: string | null, platform: string): string {
  return shortcutLabelParts(binding, platform).join(platform === "darwin" ? "" : "+");
}
function reservedShortcut(binding: string, command: ShortcutCommand, platform: string): string | undefined {
  const parts = binding.split("+");
  const key = parts.pop() ?? "";
  const held = new Set(parts);
  if (["F5", "F6", "F11", "F12"].includes(key)) return "此组合保留给浏览器或系统操作";
  if (!held.size) {
    if (key === "Escape" && command === "stop-run") return undefined;
    if (/^F(?:[1-9]|1\d|2[0-4])$/.test(key)) return undefined;
    return "请使用带修饰键的组合，Escape 仅用于停止回复";
  }
  if (
    [
      "Tab",
      "Backspace",
      "Delete",
      "Insert",
      "Home",
      "End",
      "PageUp",
      "PageDown",
      "Up",
      "Down",
      "Left",
      "Right",
    ].includes(key)
  )
    return "此组合保留给系统导航或文本编辑";
  if (key === "Escape") return "Escape 组合保留给系统或弹窗操作";
  const quickChatAltShortcut =
    command.startsWith("quick-chat") &&
    held.has("Alt") &&
    [...held].every((modifier) => modifier === "Alt" || modifier === "Shift") &&
    (/^[A-Z]$/.test(key) || (platform === "darwin" && key === "Space"));
  if (!held.has("Control") && !held.has("Command") && !/^F\d+$/.test(key) && !quickChatAltShortcut)
    return "请包含 Ctrl 或 Command，避免影响正常输入";
  const primary = platform === "darwin" ? "Command" : "Control";
  if (
    held.has(primary) &&
    [
      "A",
      "C",
      "X",
      "V",
      "Z",
      "Y",
      "W",
      "Q",
      "H",
      "M",
      "O",
      "P",
      "S",
      "R",
      ",",
      "+",
      "Plus",
      "-",
      "=",
      "0",
    ].includes(key)
  )
    return "此组合保留给编辑、窗口或浏览器操作";
  if (
    platform === "darwin" &&
    held.has("Control") &&
    !held.has("Command") &&
    !held.has("Alt") &&
    ["A", "B", "C", "D", "E", "F", "H", "K", "L", "N", "O", "P", "T", "U", "V", "W", "Y", "Z"].includes(key)
  )
    return "此组合保留给原生文本编辑和终端";
  if (
    (held.has("Alt") && key === "F4") ||
    (key === "I" && held.has(primary) && held.has(platform === "darwin" ? "Alt" : "Shift")) ||
    (platform === "darwin" && held.has("Control") && held.has("Command") && key === "F") ||
    (held.has("Command") && platform !== "darwin") ||
    (key === "Space" && (held.has("Command") || held.has("Control"))) ||
    (platform === "darwin" && held.has("Command") && held.has("Shift") && ["3", "4", "5"].includes(key))
  )
    return "此组合保留给系统操作";
  return undefined;
}
/** An error string is suitable for inline display; undefined means valid. */
export function validateShortcuts(input: unknown, platform: string): string | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return "快捷键设置无效";
  const settings = input as Partial<ShortcutSettings>;
  if (
    Object.keys(settings).some((key) => !["enabled", "bindings"].includes(key)) ||
    typeof settings.enabled !== "boolean" ||
    !settings.bindings ||
    typeof settings.bindings !== "object" ||
    Array.isArray(settings.bindings)
  )
    return "快捷键设置无效";
  const ids = shortcutCommands.map(({ id }) => id);
  if (Object.keys(settings.bindings).some((id) => !(ids as string[]).includes(id)))
    return "包含未知快捷键命令";
  const seen = new Map<string, string>();
  for (const { id, label } of shortcutCommands) {
    const value = settings.bindings[id];
    if (value === null) continue;
    if (typeof value !== "string") return `${label}：快捷键无效`;
    const binding = normalizeShortcut(value, platform);
    if (!binding) return `${label}：快捷键格式无效`;
    const reserved = reservedShortcut(binding, id, platform);
    if (reserved) return `${label}：${reserved}`;
    const duplicate = seen.get(binding);
    if (duplicate) return `${label}：与「${duplicate}」的快捷键冲突`;
    seen.set(binding, label);
  }
  return undefined;
}
export function normalizeShortcuts(settings: ShortcutSettings, platform: string): ShortcutSettings {
  const error = validateShortcuts(settings, platform);
  if (error) throw new Error(`invalid_input: ${error}`);
  return {
    enabled: settings.enabled,
    bindings: Object.fromEntries(
      shortcutCommands.map(({ id }) => [
        id,
        settings.bindings[id] === null ? null : normalizeShortcut(settings.bindings[id], platform),
      ]),
    ) as ShortcutSettings["bindings"],
  };
}

/** Adding a command never steals a user's existing custom binding. */
function withMissingShortcut(
  settings: ShortcutSettings,
  platform: string,
  command: ShortcutCommand,
  defaultBinding: () => string | null,
): ShortcutSettings {
  if (!settings?.bindings || Object.hasOwn(settings.bindings, command)) return settings;
  const binding = defaultBinding();
  const normalizedBinding = binding === null ? null : normalizeShortcut(binding, platform);
  const occupied = Object.values(settings.bindings).some(
    (value) => typeof value === "string" && normalizeShortcut(value, platform) === normalizedBinding,
  );
  return { ...settings, bindings: { ...settings.bindings, [command]: occupied ? null : binding } };
}

export function withTaskMenuShortcut(settings: ShortcutSettings, platform: string): ShortcutSettings {
  return withMissingShortcut(settings, platform, "task-menu", () =>
    platform === "darwin" ? "Command+U" : "Control+U",
  );
}

/** Keep rollout order and conflict precedence shared by storage and default migration. */
export function withAddedShortcuts(settings: ShortcutSettings, platform: string): ShortcutSettings {
  const defaults = defaultShortcuts(platform).bindings;
  for (const command of [
    "quick-chat",
    "quick-chat-new",
    "quick-chat-screenshot",
    "quick-chat-selection",
    "quick-chat-clipboard",
    "pane-full-view",
  ] as const)
    settings = withMissingShortcut(settings, platform, command, () => defaults[command]);
  return settings;
}
