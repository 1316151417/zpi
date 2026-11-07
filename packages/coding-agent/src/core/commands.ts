export const localCommands = [{ name: "compact", description: "摘要旧对话，保留完整历史" }] as const;
export function listCommands(
  commands: readonly { name: string; description: string }[] = [],
): { name: string; description: string }[] {
  return [...commands, ...localCommands].map(({ name, description }) => ({ name, description }));
}
export type ParsedInput = { kind: "prompt"; text: string } | { kind: "compact"; args: string };
export function parseInput(text: string): ParsedInput {
  const trimmed = text.trim();
  const command = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(trimmed);
  if (command && command[1] === "compact") {
    const name = command[1];
    return { kind: name, args: command[2]?.trim() ?? "" };
  }
  return { kind: "prompt", text };
}
