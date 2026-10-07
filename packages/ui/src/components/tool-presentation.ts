// Adapted from ZCode exploreToolCall.ts, conversationAssistantWorkItems.ts and
// ToolCallBlocks/renderers (872ad96, Apache-2.0); see THIRD_PARTY_NOTICES.md.
import type { ViewBlock } from "../types.ts";

export type ToolView = Extract<ViewBlock, { type: "tool" }>;
export type ToolGroupView = {
  kind: "explore" | "execute";
  id: string;
  children: ToolView[];
  running: boolean;
};
export type ProcessItem = { kind: "block"; block: ViewBlock; id: string } | ToolGroupView;

export function toolInput(block: ToolView): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(block.argsText);
    if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  } catch {
    // 流式参数尚未组成 JSON 时不能提前猜测命令分类，以免父分组跳位。
  }
  return {};
}

export function toolCommand(block: ToolView): string {
  const input = toolInput(block);
  return typeof input.command === "string" ? input.command.trim() : "";
}

export function executionCommand(command: string): string {
  return command
    .trim()
    .replace(/^(?:\/bin\/)?(?:zsh|bash|sh)\s+-lc\s+/i, "")
    .trim();
}

export function patchPreviewLines(patch: string): string[] {
  const lines = patch.split(/\r?\n/);
  let inHunk = false;
  const body: string[] = [];
  for (const line of lines) {
    if (line === "@@" || line.startsWith("@@ ")) {
      inHunk = true;
      continue;
    }
    if (inHunk) body.push(line);
  }
  const content = inHunk
    ? body
    : lines.filter((line) => line.trim() && !/^(diff --git |index |--- |\+\+\+ )/.test(line));
  // ZCode 保留首尾共 799 行，中间用计数标记替代，避免展开大补丁阻塞主线程。
  const preview =
    content.length > 800
      ? [
          ...content.slice(0, 400),
          `\\ __ZCODE_DIFF_TRUNCATED__:${content.length - 799}`,
          ...content.slice(-399),
        ]
      : [...content];
  while (preview.at(-1) === "") preview.pop();
  return preview.length ? preview : [""];
}

export function unwrapCommand(command: string): string {
  const trimmed = command.trim();
  const shell = /^(?:\/bin\/)?(?:zsh|bash|sh)\s+-lc\s+([\s\S]+)$/i.exec(trimmed);
  const powershell = /^(?:powershell(?:\.exe)?|pwsh(?:\.exe)?)\b[\s\S]*?\s-(?:command|c)\s+([\s\S]+)$/i.exec(
    trimmed,
  );
  const inner = (shell?.[1] ?? powershell?.[1] ?? trimmed).trim();
  return ['"', "'"].includes(inner[0]) && inner.at(-1) === inner[0] ? inner.slice(1, -1).trim() : inner;
}

const READ_COMMAND =
  /\b(rg|grep|find|ls|cat|head|tail|wc|stat|pwd|which|readlink|tree|sed\s+-n|get-childitem|gci|dir|get-content|gc|type|select-string|sls|get-location|test-path|resolve-path)\b|^git\s+(status|log|show|diff)\b/i;
const WRITE_COMMAND =
  /\b(sed\s+-i|perl\s+-pi|tee|mv|cp|rm|mkdir|rmdir|touch|truncate|chmod|chown|remove-item|del|erase|set-content|add-content|clear-content|out-file|new-item|move-item|copy-item|rename-item|set-item)\b|^git\s+(add|commit|rm|mv|checkout|switch|restore|reset|clean|revert|cherry-pick|merge|rebase)\b/i;
const WRITE_REDIRECT = /(^|[^\d<])>>?\s*\S|&>\s*\S/i;

export function toolGroupKind(block: ToolView): ToolGroupView["kind"] | undefined {
  if (block.name === "read") return "explore";
  if (block.name !== "bash") return;
  const commands = unwrapCommand(toolCommand(block))
    .split(/&&|\|\||;/g)
    .map((part) => part.trim())
    .filter(Boolean);
  if (!commands.length) return;
  if (commands.some((part) => WRITE_COMMAND.test(part) || WRITE_REDIRECT.test(part))) return "execute";
  return commands.some((part) => READ_COMMAND.test(part)) ? "explore" : "execute";
}

export function processItems(blocks: ViewBlock[], running: boolean): ProcessItem[] {
  const visible = blocks.filter(
    (block) =>
      !(block.type === "thinking" && !block.text.trim()) &&
      !(
        block.type === "tool" &&
        block.name === "bash" &&
        ["preparing", "running"].includes(block.status) &&
        !toolCommand(block)
      ),
  );
  const items: ProcessItem[] = [];
  for (let index = 0; index < visible.length; ) {
    const block = visible[index];
    const kind = block.type === "tool" ? toolGroupKind(block) : undefined;
    if (block.type !== "tool" || !kind) {
      items.push({ kind: "block", block, id: block.id });
      index++;
      continue;
    }
    const children = [block];
    index++;
    while (index < visible.length) {
      const next = visible[index];
      if (next.type !== "tool" || toolGroupKind(next) !== kind) break;
      children.push(next);
      index++;
    }
    // 和 ZCode 一样，第二个连续同类工具到达才升级父组；身份固定在首项。
    if (children.length === 1) items.push({ kind: "block", block, id: block.id });
    else
      items.push({ kind, id: `${kind}:${block.id}`, children, running: running && index === visible.length });
  }
  return items;
}

export function groupSummary(group: ToolGroupView): string {
  if (group.kind === "execute") {
    const failed = group.children.filter((block) => block.status === "error").length;
    return [`${group.children.length} 个命令`, ...(failed ? [`${failed} 个失败`] : [])].join(", ");
  }
  const counts = { search: 0, list: 0, file: 0 };
  for (const block of group.children) {
    const command = unwrapCommand(toolCommand(block)).toLowerCase();
    if (/(^|\s)(rg|grep|ripgrep|git\s+grep)(\s|$)/i.test(command)) counts.search++;
    else if (/(^|\s)(ls|find|tree|dir)(\s|$)/i.test(command)) counts.list++;
    else counts.file++;
  }
  return (
    [
      [counts.search, "搜索"],
      [counts.list, "列表"],
      [counts.file, "文件"],
    ] as const
  )
    .filter(([count]) => count > 0)
    .map(([count, label]) => `${count} ${label}`)
    .join(", ");
}

export function toolFile(block: ToolView, cwd?: string) {
  const value = toolInput(block).path;
  const path = block.fileChange?.path ?? (typeof value === "string" ? value.trim() : "");
  if (!path) return;
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  const root = cwd?.replace(/\\/g, "/").replace(/\/+$/, "");
  const relative = root && normalized.startsWith(`${root}/`) ? normalized.slice(root.length + 1) : normalized;
  const name = normalized.split("/").at(-1) || normalized;
  const directory = relative.slice(0, Math.max(0, relative.length - name.length));
  return { path, name, directory };
}

export function toolLabel(block: ToolView): string {
  const running = block.status === "preparing" || block.status === "running";
  const labels: Record<string, [string, string]> = {
    read: ["正在读取", "读取"],
    bash: ["正在执行", "终端"],
    write: ["正在写入", "写入"],
    edit: ["正在编辑", "编辑"],
  };
  return labels[block.name]?.[running ? 0 : 1] ?? block.name;
}
