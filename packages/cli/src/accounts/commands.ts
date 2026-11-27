import { UsageError } from "../args.ts";
import type { Accounts } from "./index.ts";
import { billing } from "./store.ts";

function requireTerminal() {
  if (!process.stdin.isTTY || !process.stderr.isTTY)
    throw new UsageError("此操作需要交互终端，请在终端运行 zpi auth。");
}

async function loginCommand(accounts: Accounts, args: string[], signal: AbortSignal) {
  let provider: string | undefined;
  let method: "oauth" | "key" | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--method" && !method) {
      const value = args[++i];
      if (value !== "key" && value !== "oauth")
        throw new UsageError("请指定 --method key 或 --method oauth。");
      method = value;
    } else if (!provider && !args[i].startsWith("-")) provider = args[i];
    else throw new UsageError("用法：zpi auth login [provider] [--method oauth|key]");
  }
  if (method === "oauth" && provider && provider !== "openai")
    throw new UsageError("仅 openai 支持 --method oauth。");
  requireTerminal();
  const { login } = await import("./login.ts");
  return login(accounts, provider, method, signal);
}

export async function runAccountCommand(
  accounts: Accounts,
  command: "auth" | "models",
  args: string[],
  signal = new AbortController().signal,
) {
  signal.throwIfAborted();
  if (command === "models") {
    if (args.length === 2 && args[0] === "--default") {
      accounts.setDefault(args[1]);
      process.stdout.write(`默认模型 ${args[1]}\n`);
      return;
    }
    if (args.length) throw new UsageError("用法：zpi models [--default 服务名/模型ID]");
    const models = accounts.availableModels();
    process.stdout.write(
      models.length
        ? models.map((m) => `${m.id}\t${m.account}\t${m.billing}${m.isDefault ? "\t默认" : ""}\n`).join("")
        : "没有可用模型。请运行 zpi auth login 或 zpi auth switch。\n",
    );
    return;
  }
  const [verb = "login", ...rest] = args;
  if (verb === "list" && !rest.length) {
    const state = accounts.snapshot;
    process.stdout.write(
      state.accounts.length
        ? state.accounts
            .map(
              (a) =>
                `${a.provider}\t${a.name}\t${billing(a)}${state.active[a.provider] === a.id ? "\t当前" : ""}${a.models.length ? "" : "\t待发现模型"}\n`,
            )
            .join("")
        : "尚无连接。请运行 zpi auth login。\n",
    );
    return;
  }
  if (verb === "switch" && rest.length === 2) {
    accounts.switchAccount(rest[0], rest[1]);
    process.stdout.write(`当前账户 ${rest[0]} ${rest[1]}\n`);
    return;
  }
  try {
    if (verb === "login") return await loginCommand(accounts, rest, signal);
    if (verb !== "logout" || rest.length)
      throw new UsageError(
        "用法：zpi auth [login [provider] [--method oauth|key] | list | switch <provider> <account> | logout]",
      );
    const state = accounts.snapshot;
    if (!state.accounts.length) {
      process.stdout.write("尚无连接。\n");
      return;
    }
    requireTerminal();
    const { select } = await import("@inquirer/prompts");
    const terminal = { output: process.stderr, signal };
    const id = await select(
      {
        message: "移除哪个 CLI 连接",
        choices: state.accounts.map((a) => ({ value: a.id, name: `${a.provider} / ${a.name}` })),
      },
      terminal,
    );
    const warning = await accounts.logout(id);
    process.stdout.write("已移除所选 CLI 连接。\n");
    if (warning) process.stderr.write(`${warning}\n`);
    const account = state.accounts.find((a) => a.id === id);
    if (
      account &&
      state.active[account.provider] === id &&
      state.accounts.some((a) => a.provider === account.provider && a.id !== id)
    )
      process.stdout.write(`请用 zpi auth switch ${account.provider} <账户名> 选择当前账户。\n`);
  } catch (error) {
    if (
      signal.aborted ||
      (error instanceof Error && ["ExitPromptError", "AbortPromptError", "AbortError"].includes(error.name))
    )
      throw Object.assign(new Error("已取消。"), { exitCode: 130 });
    throw error;
  }
}
