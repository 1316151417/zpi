export const commands = [
  { name: "help", description: "查看命令和键位" },
  { name: "exit", description: "退出终端" },
  { name: "clear", description: "打开空会话，保留原历史" },
  { name: "resume", description: "继续当前目录的一条会话" },
  { name: "model", description: "选择本会话的模型" },
  { name: "effort", description: "设置本会话的推理档位" },
  { name: "context", description: "查看当前上下文用量" },
  { name: "compact", description: "压缩上下文，可附加要求" },
  { name: "init", description: "根据当前目录维护 AGENTS.md" },
  { name: "skills", description: "为下一条消息选择 Skill" },
];
export const builtinNames = new Set(commands.map((command) => command.name));
