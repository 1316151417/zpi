// Manual release acceptance. Importing the module never opens a browser or contacts a provider.
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Model } from "@zpi-dev/ai";
import {
  type ChatGPTCredential,
  isChatGPTCredential,
  revokeChatGPTCredential,
} from "@zpi-dev/ai/auth/openai-chatgpt";
import { ModelRuntime, runModelExchange } from "@zpi-dev/coding-agent";
import { ChatGPTAuth } from "../../desktop/src/main/chatgpt-auth.ts";
import { modelRuntimeConfig } from "../../desktop/src/main/model-runtime-config.ts";
import { SettingsStore } from "../../desktop/src/main/storage.ts";
import { Accounts } from "../src/accounts/index.ts";
import { serviceFor } from "../src/accounts/services.ts";

type Client = "Desktop" | "CLI";
interface AcceptanceOptions {
  fetcher: typeof fetch;
  authorize(client: Client, url: URL): Promise<void>;
  report(message: string): void;
  signal: AbortSignal;
}

async function probe(runtime: ModelRuntime, model: Model, signal: AbortSignal) {
  const result = await runModelExchange({
    runtime,
    model,
    systemPrompt: "Answer the user's request in one word.",
    prompt: "Reply OK.",
    signal: AbortSignal.any([signal, AbortSignal.timeout(120000)]),
  });
  if (result.error || !result.message?.content.some((part) => part.type === "text" && part.text.trim()))
    throw new Error("模型调用失败");
}

export async function verifyIndependentSubscriptions({
  fetcher,
  authorize,
  report,
  signal,
}: AcceptanceOptions) {
  signal.throwIfAborted();
  const root = await mkdtemp(join(tmpdir(), "zpi-subscription-acceptance-"));
  const secrets = new Map<string, string>();
  // Credentials live only in these two stores in this process, including while checking revocation.
  const settings = new SettingsStore(join(root, "desktop"), {
    isEncryptionAvailable: () => false,
    encryptString: () => {
      throw new Error("验收凭据仅存内存");
    },
    decryptString: () => {
      throw new Error("验收凭据仅存内存");
    },
  });
  const accounts = new Accounts(join(root, "cli"), {
    env: {},
    fetch: fetcher,
    secrets: {
      get: (key) => secrets.get(key) ?? null,
      set: (key, value) => {
        secrets.set(key, value);
      },
      delete: (key) => {
        secrets.delete(key);
      },
    },
  });
  const desktop = new ChatGPTAuth(settings, fetcher);
  const stopDesktop = () => desktop.close();
  signal.addEventListener("abort", stopDesktop, { once: true });
  let desktopId: string | undefined;
  let cliId: string | undefined;
  let uncommitted: ChatGPTCredential | undefined;
  let stage = "";
  let failure: string | undefined;
  let cleanupFailed = false;
  const step = (name: string) => {
    stage = name;
    report(name);
    signal.throwIfAborted();
  };
  try {
    step("在浏览器中使用专用测试账号授权 Desktop");
    const first = await desktop.begin(null);
    const desktopUrl = new URL(first.url);
    if (desktopUrl.searchParams.get("client_id") !== "dynamic_agent_client") throw new Error("需要首次授权");
    await authorize("Desktop", desktopUrl);
    const opened = await desktop.complete(first.loginId);
    desktopId = opened.providerId;
    const desktopCredential = settings.getChatGPTCredential(desktopId);
    if (!desktopCredential || !isChatGPTCredential(desktopCredential)) throw new Error("授权无效");
    const config = settings.snapshot(desktopId);
    const desktopListed = new Set(
      config.models.filter((m) => m.availability === "listed" && m.enabled !== false).map((m) => m.id),
    );
    step("在浏览器中使用同一专用测试账号授权 CLI");
    const account = await accounts.connect(
      serviceFor("openai", "oauth"),
      "acceptance",
      { kind: "oauth" },
      {
        signal,
        authorize: async (login) => {
          const cliUrl = new URL(login.url);
          if (
            cliUrl.searchParams.get("client_id") !== "dynamic_agent_client" ||
            cliUrl.searchParams.get("ext_agent_host_id") === desktopUrl.searchParams.get("ext_agent_host_id")
          )
            throw new Error("需要独立的首次授权");
          const abort = () => login.cancel();
          signal.addEventListener("abort", abort, { once: true });
          try {
            signal.throwIfAborted();
            await authorize("CLI", cliUrl);
            uncommitted = await login.wait();
            return uncommitted;
          } finally {
            signal.removeEventListener("abort", abort);
          }
        },
        chooseModels: async (models) => {
          const model = models.find((m) => m.availability === "listed" && desktopListed.has(m.id));
          if (!model) throw new Error("缺少共同可用的订阅模型");
          return [model];
        },
        chooseDefault: async ([id]) => id,
        warn: () => {},
      },
    );
    cliId = account.id;
    uncommitted = undefined;
    step("核对已验证的账号主体及服务方签发的应用 ID");
    const cliCredential: unknown =
      account.credential.kind === "oauth" ? JSON.parse(secrets.get(account.credential.ref) ?? "null") : null;
    if (
      !isChatGPTCredential(cliCredential) ||
      cliCredential.subject !== desktopCredential.subject ||
      cliCredential.clientId === desktopCredential.clientId
    )
      throw new Error("账户或应用标识不符合验收条件");
    const selected = await accounts.selectModel();
    const desktopRuntime = await ModelRuntime.create({ fetch: fetcher });
    const provider = desktopId;
    desktopRuntime.registerProvider(
      provider,
      modelRuntimeConfig(config, (rejected) => settings.getRequestApiKey(provider, fetcher, rejected)),
    );
    const model = desktopRuntime.getModel(provider, selected.model.id);
    if (model?.auth !== "chatgpt" || selected.model.auth !== "chatgpt") throw new Error("订阅模型不可用");
    step("调用 Desktop 的订阅模型");
    await probe(desktopRuntime, model, signal);
    step("调用 CLI 的同一订阅模型");
    await probe(selected.runtime, selected.model, signal);
    step("撤销本次 CLI 授权");
    const warning = await accounts.logout(cliId);
    cliId = undefined;
    if (warning) throw new Error("无法确认远端撤销");
    step("再次调用 Desktop 的订阅模型");
    await probe(desktopRuntime, model, signal);
  } catch {
    // Upstream errors may contain callback parameters, credentials, user names or model output.
    failure = `验收未通过，检查步骤「${stage}」。`;
  } finally {
    signal.removeEventListener("abort", stopDesktop);
    desktop.close();
    const revoked = await Promise.allSettled([
      cliId
        ? accounts.logout(cliId)
        : uncommitted
          ? revokeChatGPTCredential(uncommitted, fetcher)
          : undefined,
      desktopId ? desktop.disconnect(desktopId).then((result) => result.warning) : undefined,
    ]);
    try {
      settings.close();
    } finally {
      secrets.clear();
      await rm(root, { recursive: true, force: true });
    }
    cleanupFailed = revoked.some((attempt) => attempt.status === "rejected" || attempt.value);
  }
  if (cleanupFailed)
    throw new Error(`${failure ?? ""}验收授权的远端清理未确认，请在专用测试账号中检查本次授权。`);
  if (failure) throw new Error(failure);
}

const usage = "node packages/cli/test/subscription-live.ts --dedicated-test-account";
if (process.argv[1] === import.meta.filename) {
  const [flag, ...extra] = process.argv.slice(2);
  if (flag !== "--dedicated-test-account" || extra.length || !process.stdin.isTTY) {
    console.log(
      `独立订阅验收需要在终端明确启动：\n${usage}\n请准备专用测试账号，并允许两次浏览器授权与三次订阅请求。`,
    );
    if (flag !== "--help") process.exitCode = 2;
  } else {
    // The SDK otherwise inherits a user's verbose HTTP logging environment.
    process.env.OPENAI_LOG = "off";
    const controller = new AbortController();
    const abort = () => controller.abort();
    process.on("SIGINT", abort);
    process.on("SIGTERM", abort);
    try {
      await verifyIndependentSubscriptions({
        fetcher: fetch,
        signal: controller.signal,
        report: (line) => console.log(line),
        authorize: async (_client, url) => {
          await promisify(execFile)(process.platform === "darwin" ? "open" : "xdg-open", [url.href], {
            signal: controller.signal,
          });
        },
      });
      console.log("验收通过。两端应用 ID 独立，撤销 CLI 后 Desktop 仍可调用。测试授权已清理。");
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      console.error(message.startsWith("验收") ? message : "验收未完成。");
      process.exitCode = controller.signal.aborted ? 130 : 1;
    } finally {
      process.off("SIGINT", abort);
      process.off("SIGTERM", abort);
    }
  }
}
