export const localCommands = [
  { name: "init", description: "检查项目并创建或编辑 AGENTS.md" },
  { name: "compact", description: "摘要旧对话，保留完整历史" },
] as const;
export function listCommands(): { name: string; description: string }[] {
  return localCommands.map((c) => ({ ...c }));
}
export type ParsedInput = { kind: "prompt"; text: string } | { kind: "init" | "compact"; args: string };
export function parseInput(text: string): ParsedInput {
  const trimmed = text.trim();
  const command = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(trimmed);
  if (command && (command[1] === "init" || command[1] === "compact")) {
    const name = command[1];
    return { kind: name, args: command[2]?.trim() ?? "" };
  }
  return { kind: "prompt", text };
}
