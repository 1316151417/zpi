export function terminalShell(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
) {
  if (platform === "win32") return { shell: env.ComSpec || env.COMSPEC || "cmd.exe", args: [] };
  return { shell: env.SHELL || (platform === "darwin" ? "/bin/zsh" : "/bin/sh"), args: ["-l"] };
}
