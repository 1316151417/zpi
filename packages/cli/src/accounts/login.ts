import { spawn } from "node:child_process";
import { checkbox, confirm, input, password, select } from "@inquirer/prompts";
import { type DiscoveredModel, type ProviderApi, providerPresets } from "@zpi-dev/ai";
import type { ChatGPTLogin } from "@zpi-dev/ai/auth/openai-chatgpt";
import { UsageError } from "../args.ts";
import type { Accounts, LoginInteraction, LoginSource } from "./index.ts";
import { allowsNoKey, cleanBaseUrl, customAlias, serviceFor, validEnvName, validName } from "./services.ts";
import { validModelId } from "./store.ts";

const choices = <T extends string>(entries: [T, string][]) =>
  entries.map(([value, name]) => ({ name, value }));

async function browserLogin(login: ChatGPTLogin, signal: AbortSignal) {
  const args = process.platform === "darwin" ? "open" : "xdg-open";
  const child = spawn(args, [login.url], { detached: true, stdio: "ignore" });
  child.on("error", () => undefined);
  child.unref();
  process.stderr.write(`在浏览器中完成 ChatGPT 授权。如需手动打开：\n${login.url}\n`);
  const stop = new AbortController();
  const context = {
    output: process.stderr,
    signal: AbortSignal.any([signal, stop.signal]),
    clearPromptOnDone: true,
  };
  const wait = login.wait();
  try {
    const paste = password(
      {
        message: "若未自动返回，可在此粘贴回调地址（隐藏输入）",
        mask: false,
        toggleMask: false,
        validate: (value) => Boolean(value.trim()) || "请粘贴完整回调地址。",
      },
      context,
    ).then((value) => {
      try {
        login.submitCallback(value);
      } catch {
        throw new Error("回调地址无效或已过期，请重新登录。");
      }
      return wait;
    });
    return await Promise.race([wait, paste]);
  } finally {
    stop.abort();
  }
}

function modelPrompts(signal: AbortSignal): LoginInteraction {
  const terminal = { output: process.stderr, signal };
  async function limit(message: string, initial: number, upper = Number.MAX_SAFE_INTEGER) {
    const value = await input(
      {
        message,
        default: String(initial),
        validate: (v) =>
          (/^\d+$/.test(v) && Number.isSafeInteger(Number(v)) && Number(v) > 0 && Number(v) <= upper) ||
          "请输入范围内的正整数。",
      },
      terminal,
    );
    return Number(value);
  }
  return {
    signal,
    authorize: (login) => browserLogin(login, signal),
    warn: (message) => process.stderr.write(`${message}\n`),
    chooseDefault: (ids) => select({ message: "默认模型", choices: ids }, terminal),
    chooseModels: async (models, previous, manual) => {
      if (!manual) {
        const previousIds = new Set(previous.map((m) => m.id));
        const retained = models.some((m) => previousIds.has(m.id));
        return checkbox(
          {
            message: "启用模型",
            required: true,
            choices: models.map((m, index) => ({
              value: m,
              name: m.availability === "unverified" ? `${m.id}（预置，待验证）` : m.id,
              checked: retained ? previousIds.has(m.id) : index === 0,
            })),
          },
          terminal,
        );
      }
      process.stderr.write("服务未提供模型目录，请填写模型信息。\n");
      const added: DiscoveredModel[] = [];
      do {
        const existing = previous[added.length];
        const id = await input(
          {
            message: "模型 ID",
            default: existing?.id,
            validate: (v) =>
              (validModelId(v) && !added.some((m) => m.id === v)) || "请输入有效且唯一的模型 ID。",
          },
          terminal,
        );
        const contextWindow = await limit("上下文上限", existing?.contextWindow ?? 32768);
        const maxTokens = await limit(
          "输出上限",
          Math.min(existing?.maxTokens ?? 4096, contextWindow),
          contextWindow,
        );
        added.push({ id, contextWindow, maxTokens });
      } while (await confirm({ message: "再添加一个模型", default: false }, terminal));
      return added;
    },
  };
}

export async function login(
  accounts: Accounts,
  provider: string | undefined,
  method: "oauth" | "key" | undefined,
  signal: AbortSignal,
) {
  const terminal = { output: process.stderr, signal };
  const state = accounts.snapshot;
  const custom = [...new Set(state.accounts.filter((a) => customAlias(a.provider)).map((a) => a.provider))];
  provider ??= await select(
    {
      message: "选择服务",
      choices: [
        ...choices([
          ["openai", "OpenAI"],
          ["anthropic", "Anthropic"],
        ]),
        ...providerPresets.filter((p) => p.family !== "openai").map((p) => ({ value: p.id, name: p.name })),
        ...custom.map((value) => ({ value, name: value })),
        { value: "custom", name: "自定义服务" },
      ],
    },
    terminal,
  );
  if (method === "oauth" && provider !== "openai") throw new UsageError("仅 openai 支持 --method oauth。");
  const configureAddress = provider === "custom";
  if (configureAddress)
    provider = await input(
      { message: "服务短名", validate: (v) => customAlias(v) || "请输入有效且未被内置服务占用的短名。" },
      terminal,
    );
  method ??=
    provider === "openai"
      ? await select(
          {
            message: "登录方式",
            choices: choices<"oauth" | "key">([
              ["oauth", "ChatGPT 订阅"],
              ["key", "OpenAI API key"],
            ]),
          },
          terminal,
        )
      : "key";
  let address: { api: ProviderApi; baseUrl: string } | undefined;
  if (customAlias(provider)) {
    const existing = state.accounts.find((a) => a.provider === provider);
    if (existing && !configureAddress) address = existing;
    else {
      const api = await select<ProviderApi>(
        {
          message: "模型协议",
          default: existing?.api,
          choices: choices([
            ["openai-completions", "OpenAI Chat Completions"],
            ["openai-responses", "OpenAI Responses"],
            ["anthropic-messages", "Anthropic Messages"],
          ]),
        },
        terminal,
      );
      const baseUrl = await input(
        {
          message: "Base URL",
          default: existing?.baseUrl,
          validate: (v) => {
            try {
              cleanBaseUrl(v);
              return true;
            } catch {
              return "请输入不含凭据或查询参数的 HTTP(S) 地址。";
            }
          },
        },
        terminal,
      );
      address = { api, baseUrl };
    }
  }
  const service = serviceFor(provider, method, address);
  const name = await input(
    {
      message: "账户名",
      default: "default",
      validate: (v) => validName(v) || "可用文字、数字、点、短横线和下划线。",
    },
    terminal,
  );
  const old = state.accounts.find((a) => a.name === name && a.provider === provider);
  let source: LoginSource;
  if (method === "oauth") {
    const reuse =
      old?.credential.kind === "oauth" &&
      (await select(
        {
          message: "订阅连接",
          choices: [
            { name: "使用当前授权重新发现模型", value: true },
            { name: "在浏览器中重新授权", value: false },
          ],
        },
        terminal,
      ));
    source = { kind: "oauth", reuse };
  } else {
    const options = choices<"key" | "env" | "none">([
      ["key", "系统密钥库（隐藏输入 API key）"],
      ["env", "环境变量"],
    ]);
    if (allowsNoKey(service)) options.push({ name: "无密钥", value: "none" });
    const kind = await select({ message: "密钥来源", choices: options }, terminal);
    if (kind === "key")
      source = {
        kind,
        value: await password(
          {
            message: "API key",
            mask: false,
            toggleMask: false,
            validate: (v) => Boolean(v.trim()) || "请输入 API key。",
          },
          terminal,
        ),
      };
    else if (kind === "env")
      source = {
        kind,
        name: await input(
          {
            message: "环境变量名",
            default: old?.credential.kind === "env" ? old.credential.name : undefined,
            validate: (v) => validEnvName(v) || "请输入变量名。",
          },
          terminal,
        ),
      };
    else source = { kind };
  }
  const account = await accounts.connect(service, name, source, modelPrompts(signal));
  process.stdout.write(
    `已连接 ${account.provider} ${account.name}，已启用 ${account.models.length} 个模型。\n`,
  );
}
