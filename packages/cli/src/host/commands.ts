export interface CliCommand {
  name: string;
  description: string;
  argumentHint?: string;
}

export function commandUsage(command: Pick<CliCommand, "name" | "argumentHint">) {
  return `/${command.name}${command.argumentHint ? ` ${command.argumentHint}` : ""}`;
}

export const commands: CliCommand[] = [
  { name: "help", description: "查看命令和键位" },
  { name: "hotkeys", description: "在对话中查看快捷键" },
  { name: "exit", description: "退出终端" },
  { name: "clear", description: "打开空会话，保留原历史" },
  { name: "resume", argumentHint: "[会话 ID 或关键词]", description: "继续当前目录的一条会话" },
  { name: "rename", argumentHint: "<会话名称>", description: "给当前会话命名" },
  { name: "model", argumentHint: "[提供商/模型或关键词]", description: "选择本会话的模型" },
  { name: "login", argumentHint: "[提供商]", description: "连接模型提供商" },
  { name: "logout", description: "断开模型提供商" },
  { name: "effort", argumentHint: "[档位]", description: "设置本会话的推理档位" },
  { name: "fast", argumentHint: "[on|off]", description: "切换当前模型的加速档位" },
  { name: "context", description: "查看当前上下文用量" },
  { name: "copy", argumentHint: "[N]", description: "复制倒数第 N 条回答，默认最近一条" },
  { name: "compact", argumentHint: "[要求]", description: "压缩上下文，可附加要求" },
  { name: "init", argumentHint: "[要求]", description: "根据当前目录维护 AGENTS.md" },
  { name: "skills", description: "选择 Skill 并插入输入框" },
];
export const builtinNames = new Set(commands.map((command) => command.name));

export function isSessionCommand(name: string) {
  return name === "init" || name === "compact";
}

export function sessionNameProblem(name: string) {
  if (!name.trim()) return "请输入会话名称。";
  if (/\p{C}/u.test(name) || Array.from(name).length > 100) return "名称须为 1 至 100 个字符的单行文字。";
}
