import { parseMentions } from "./mentions.ts";
export const localCommands = [
  { name: "init", description: "检查项目并创建或编辑 AGENTS.md" },
  { name: "compact", description: "摘要旧对话，保留完整历史" },
] as const;
export function listCommands(): { name: string; description: string }[] {
  return localCommands.map((c) => ({ ...c }));
}
export type ParsedInput =
  | { kind: "prompt"; text: string }
  | { kind: "skill"; name: string; task: string }
  | { kind: "init" | "compact"; args: string };
export function parseInput(text: string): ParsedInput {
  let trimmed = text.trim();
  const first = parseMentions(trimmed)[0];
  if (first?.kind === "skill" && first.start === 0) trimmed = `$${first.label}${trimmed.slice(first.end)}`;
  const command = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(trimmed);
  if (command) {
    const name = command[1];
    if (name !== "init" && name !== "compact") throw new Error(`invalid_input: 未知命令 /${name}`);
    return { kind: name, args: command[2]?.trim() ?? "" };
  }
  const skill = /^\$([a-z0-9]+(?:-[a-z0-9]+)*)(?:\s+([\s\S]*))?$/.exec(trimmed);
  if (skill) return { kind: "skill", name: skill[1], task: skill[2]?.trim() ?? "" };
  return { kind: "prompt", text };
}
