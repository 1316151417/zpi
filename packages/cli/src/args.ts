import { parseArgs } from "node:util";

export const help = `zpi [选项] [问题]
  zpi                           在当前目录开始交互
  zpi -c                        继续当前目录最近的会话
  zpi -r [id]                   选择或恢复当前目录的会话
  zpi -p [问题]                 从参数或 stdin 读取，只打印本轮回答
  zpi -m <provider/model>       为本次调用指定模型
  zpi --effort <档位>           为本次调用指定推理强度
  zpi --help | --version

  zpi auth login [provider] [--method key|oauth]
  zpi auth list
  zpi auth switch <provider> <account>
  zpi auth logout
  zpi models [--default <provider/model>]

示例
  zpi auth login anthropic --method key
  zpi -m openai/gpt-5 -p "解释当前目录的用途"
  git diff | zpi -p "说明改动的影响"`;

export class UsageError extends Error {
  readonly exitCode = 2;
}

export type Invocation =
  | { kind: "help" | "version" }
  | { kind: "accounts"; command: "auth" | "models"; args: string[] }
  | {
      kind: "session";
      prompt: string;
      print: boolean;
      latest: boolean;
      resume?: true | string;
      model?: string;
      effort?: string;
    };

export function parseInvocation(args: string[]): Invocation {
  const [command, ...rest] = args;
  if (command === "auth" || command === "models") {
    return rest.includes("--help") || rest.includes("-h")
      ? { kind: "help" }
      : { kind: "accounts", command, args: rest };
  }
  // Node's parseArgs has no optional string argument. A bare -r opens the picker.
  const normalized: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const argument = args[i];
    if (argument === "--") {
      normalized.push(...args.slice(i));
      break;
    }
    if ((argument === "-r" || argument === "--resume") && !args[i + 1]?.startsWith("-") && args[i + 1]) {
      normalized.push(`--resume=${args[++i]}`);
    } else if (argument === "-r" || argument === "--resume") {
      normalized.push("--resume=");
    } else {
      normalized.push(argument);
    }
  }
  try {
    const { values, positionals } = parseArgs({
      args: normalized,
      allowPositionals: true,
      options: {
        help: { type: "boolean", short: "h" },
        version: { type: "boolean", short: "v" },
        print: { type: "boolean", short: "p" },
        continue: { type: "boolean", short: "c" },
        resume: { type: "string", short: "r" },
        model: { type: "string", short: "m" },
        effort: { type: "string" },
      },
    });
    if (values.help) return { kind: "help" };
    if (values.version) return { kind: "version" };
    if (values.continue && values.resume !== undefined) throw new UsageError("-c 和 -r 只能选一个");
    if (values.print && values.resume === "") throw new UsageError("打印模式请使用 -r <id> 或 -c");
    if (values.model !== undefined && !/^[^/\s]+\/\S+$/.test(values.model))
      throw new UsageError("-m 需要 provider/model，可用 zpi models 查看");
    if (values.effort !== undefined && !values.effort.trim()) throw new UsageError("--effort 需要推理档位");
    return {
      kind: "session",
      prompt: positionals.join(" "),
      print: values.print ?? false,
      latest: values.continue ?? false,
      resume: values.resume === "" ? true : values.resume,
      model: values.model,
      effort: values.effort,
    };
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
}

export function printPrompt(prompt: string, stdin: string): string {
  const parts = [prompt, stdin].filter((part) => part.trim().length > 0);
  if (!parts.length) throw new UsageError("-p 需要问题或非空的 stdin 输入");
  return parts.join("\n\n");
}
