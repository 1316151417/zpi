import type { CustomCommand } from "../shared/custom-commands.ts";

export function parseCustomCommandInvocation(text: string): { name: string; args: string } | undefined {
  const match = /^\/([a-z0-9_-][a-z0-9_:-]*(?:\/[a-z0-9_-][a-z0-9_:-]*)*)(?:\s+([\s\S]*))?$/i.exec(
    text.trim(),
  );
  if (!match || match[1].length > 1024) return;
  const name = match[1].toLowerCase().replaceAll(":", "/");
  if (["init", "compact", "side", "btw"].includes(name)) return;
  return { name, args: match[2]?.trim() ?? "" };
}

export function splitCustomCommandArguments(input: string): string[] {
  const args: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  let escaping = false;
  let started = false;
  for (const char of input) {
    if (!quote && !escaping && /\s/.test(char)) {
      if (started) args.push(current);
      current = "";
      started = false;
      continue;
    }
    started = true;
    if (escaping) {
      current += char;
      escaping = false;
    } else if (char === "\\") escaping = true;
    else if (quote) {
      if (char === quote) quote = undefined;
      else current += char;
    } else if (char === "'" || char === '"') quote = char;
    else current += char;
  }
  if (escaping) current += "\\";
  if (started) args.push(current);
  return args;
}

export interface CustomCommandExpansionPlan {
  name: string;
  source: string;
  parts: ({ kind: "text"; text: string } | { kind: "shell"; command: string })[];
}

export function prepareCustomCommandPrompt(
  command: Pick<CustomCommand, "name" | "prompt">,
  rawArguments: string,
  source = "user/zpi",
): CustomCommandExpansionPlan {
  const name = command.name.replace(/^\/+/, "");
  const args = rawArguments.trim();
  const positional = splitCustomCommandArguments(args);
  let usedPlaceholder = false;
  // 只替换原模板，避免用户参数中的 $1 或 $ARGUMENTS 被再次解释而改写原文。
  const expand = (text: string) =>
    text.replace(/\$ARGUMENTS|\$(\d+)/g, (token, index: string | undefined) => {
      usedPlaceholder = true;
      return token === "$ARGUMENTS" ? args : (positional[Number(index) - 1] ?? "");
    });
  const parts: CustomCommandExpansionPlan["parts"] = [];
  // 先识别模板中的 Shell 段，再替换参数；用户参数中的 !`…` 不能新增执行动作。
  const pattern = /```!\s*\r?\n?([\s\S]*?)```|!`([^`]*)`/g;
  let cursor = 0;
  for (const match of command.prompt.matchAll(pattern)) {
    parts.push({ kind: "text", text: expand(command.prompt.slice(cursor, match.index)) });
    parts.push({ kind: "shell", command: expand((match[1] ?? match[2]).trim()) });
    cursor = match.index + match[0].length;
  }
  parts.push({ kind: "text", text: expand(command.prompt.slice(cursor)) });
  if (args && !usedPlaceholder) {
    const last = parts.at(-1);
    if (last?.kind === "text") last.text = last.text.trimEnd();
    parts.push({ kind: "text", text: `\n\nUser arguments:\n${args}` });
  }
  return { name, source, parts };
}

function formatPrompt(plan: CustomCommandExpansionPlan, body: string): string {
  return [`Run custom command /${plan.name}.`, `Command source: ${plan.source}.`, "", body.trim()].join("\n");
}

export function expandCustomCommandPrompt(
  command: Pick<CustomCommand, "name" | "prompt">,
  rawArguments: string,
  source = "user/zpi",
): string {
  const plan = prepareCustomCommandPrompt(command, rawArguments, source);
  const body = plan.parts.map((part) => {
    if (part.kind === "shell")
      throw new Error(`invalid_input: 自定义指令 /${plan.name} 不支持自动 Shell 展开，需要授权的执行器`);
    return part.text;
  });
  return formatPrompt(plan, body.join(""));
}

export async function expandCustomCommandPromptWithShell(
  command: Pick<CustomCommand, "name" | "prompt">,
  rawArguments: string,
  runShell: (command: string) => Promise<string>,
  source = "user/zpi",
): Promise<string> {
  const plan = prepareCustomCommandPrompt(command, rawArguments, source);
  let body = "";
  for (const part of plan.parts)
    body += part.kind === "text" ? part.text : part.command ? (await runShell(part.command)).trimEnd() : "";
  return formatPrompt(plan, body);
}
