import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { text } from "node:stream/consumers";
import { help, parseInvocation, printPrompt, UsageError } from "./args.ts";

declare const ZPI_CLI_VERSION: string;

const controller = new AbortController();
let brokenPipe = false;
const interrupt = () => controller.abort();
process.on("SIGINT", interrupt);
process.on("SIGTERM", interrupt);
process.stdout.on("error", (error: NodeJS.ErrnoException) => {
  if (error.code === "EPIPE") {
    brokenPipe = true;
    interrupt();
  } else {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
    interrupt();
  }
});

async function main(): Promise<number> {
  const invocation = parseInvocation(process.argv.slice(2));
  if (invocation.kind === "help" || invocation.kind === "version") {
    process.stdout.write(`${invocation.kind === "help" ? help : ZPI_CLI_VERSION}\n`);
    return 0;
  }
  const homeDir = realpathSync(homedir());
  const root = join(homeDir, ".zpi", "cli");
  // Both provider SDKs otherwise import arbitrary shell headers and can log complete HTTP exchanges.
  // Keep the original values available only for a credential explicitly bound by name in zpi auth.
  const credentialEnv = { ...process.env };
  for (const name of ["OPENAI_CUSTOM_HEADERS", "ANTHROPIC_CUSTOM_HEADERS", "OPENAI_LOG", "ANTHROPIC_LOG"])
    delete process.env[name];
  const { Accounts, runAccountCommand } = await import("./accounts/index.ts");
  const accounts = new Accounts(root, { env: credentialEnv });
  if (invocation.kind === "accounts") {
    await runAccountCommand(accounts, invocation.command, invocation.args, controller.signal);
    return 0;
  }
  if (invocation.kind !== "session") return 0;
  const { print, latest, resume, model, effort } = invocation;
  if (!print && !(process.stdin.isTTY && process.stdout.isTTY))
    throw new UsageError("交互模式需要终端。管道或脚本请使用 zpi -p [问题]");
  let prompt = invocation.prompt;
  let literal = false;
  if (print) {
    // Cancel a pending pipe read as well as any subsequent model request.
    const stopRead = () => process.stdin.destroy();
    controller.signal.addEventListener("abort", stopRead, { once: true });
    try {
      controller.signal.throwIfAborted();
      const piped = process.stdin.isTTY ? "" : await text(process.stdin);
      literal = Boolean(prompt.trim() && piped.trim());
      prompt = printPrompt(prompt, piped);
    } finally {
      controller.signal.removeEventListener("abort", stopRead);
    }
  }
  controller.signal.throwIfAborted();
  const { CliHost } = await import("./host/index.ts");
  const host = new CliHost({
    cwd: process.cwd(),
    root,
    homeDir,
    accounts,
    model,
    effort,
    print,
    ephemeral: print && !latest && !resume,
  });
  try {
    if (latest) await host.resumeLatest();
    if (typeof resume === "string") await host.resume(resume);
    if (print) {
      const answer = await host.run(prompt, { signal: controller.signal, literal });
      controller.signal.throwIfAborted();
      await new Promise<void>((resolve, reject) => {
        process.stdout.write(`${answer}\n`, (error) => (error ? reject(error) : resolve()));
      });
      return 0;
    }
    const { runInteractive } = await import("./tui/index.ts");
    return await runInteractive({
      host,
      initialPrompt: prompt,
      selectSession: resume === true,
      listModels: async () =>
        accounts
          .availableModels()
          .map((item) => ({ name: item.id, description: `${item.account} · ${item.billing}` })),
      signal: controller.signal,
    });
  } finally {
    await host.close();
  }
}

try {
  const code = await main();
  process.exitCode = brokenPipe ? 0 : controller.signal.aborted ? 130 : code;
} catch (error) {
  const detail = error as { code?: string; exitCode?: number };
  if (brokenPipe || detail?.code === "EPIPE") process.exitCode = 0;
  else if (controller.signal.aborted || detail?.exitCode === 130) process.exitCode = 130;
  else {
    process.stderr.write(`zpi: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = detail?.exitCode ?? 1;
  }
} finally {
  process.off("SIGINT", interrupt);
  process.off("SIGTERM", interrupt);
}
