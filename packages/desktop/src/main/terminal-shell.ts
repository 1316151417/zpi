export function terminalShell(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
) {
  return { shell: env.SHELL || (platform === "darwin" ? "/bin/zsh" : "/bin/sh"), args: ["-l"] };
}
