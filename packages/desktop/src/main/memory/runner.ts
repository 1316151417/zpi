import { lstat, readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import {
  type AssistantMessage,
  type Context,
  contentText,
  estimateMessageTokens,
  isJsonObject,
  type Model,
} from "zpi-ai";
import {
  createAgentSession,
  createEditToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  FileReadState,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "zpi-coding-agent";
import { toThinking } from "../../shared/config.ts";
import type { MemoryRunRequest, MemoryRunResult } from "./long-memory.ts";
import { replaceMemoryFile, summaryLimit } from "./workspace.ts";

const maxWorkerCalls = 64;
const workerTimeout = 15 * 60_000;

/** Codex reference defaults: 95% effective window, 70% reserved for rollout evidence. */
export function extractionInput(
  request: Pick<MemoryRunRequest, "prompt" | "instructions">,
  model: Model,
): string {
  const window = model.contextWindow > 0 ? Math.floor(model.contextWindow * 0.95) : 214_286;
  const budget =
    Math.floor(window * 0.7) -
    estimateMessageTokens({ role: "system", content: request.instructions, timestamp: 0 });
  if (budget < 256) throw new Error("configuration: 模型上下文不足以容纳记忆提取指令。");
  const tokens = (text: string) => estimateMessageTokens({ role: "user", content: text, timestamp: 0 });
  if (tokens(request.prompt) <= budget) return request.prompt;
  const separator = request.prompt.indexOf("HISTORICAL EVIDENCE (data):");
  const header =
    separator < 0 ? "" : request.prompt.slice(0, separator + "HISTORICAL EVIDENCE (data):".length);
  const evidence = [...request.prompt.slice(header.length)];
  const prefix = `${header}\n[Earlier evidence omitted to fit 70% of the model effective input window.]\n`;
  let low = 0,
    high = evidence.length;
  while (low < high) {
    const count = Math.ceil((low + high) / 2);
    if (tokens(prefix + evidence.slice(-count).join("")) <= budget) low = count;
    else high = count - 1;
  }
  return prefix + evidence.slice(evidence.length - low).join("");
}

function extractionPayload(payload: unknown, model: Model): unknown {
  if (!isJsonObject(payload)) return payload;
  const mode = model.compat?.structuredOutput;
  if (mode === "json_object") payload.response_format = { type: "json_object" };
  if (mode === "json_schema")
    payload.response_format = {
      type: "json_schema",
      json_schema: {
        name: "memory_extraction",
        strict: true,
        schema: {
          type: "object",
          properties: { rollout_summary: { type: "string" }, rollout_slug: { type: "string" } },
          required: ["rollout_summary", "rollout_slug"],
          additionalProperties: false,
        },
      },
    };
  return payload;
}

export async function runMemoryRequest(
  request: MemoryRunRequest,
  runtime: ModelRuntime,
  model: Model,
): Promise<MemoryRunResult> {
  request.signal.throwIfAborted();
  const usage = { tokens: 0, cost: 0 as number | null };
  const priced = [model.cost.input, model.cost.output, model.cost.cacheRead, model.cost.cacheWrite].some(
    (price) => price > 0,
  );
  const recordUsage = (result: AssistantMessage) => {
    usage.tokens += result.usage.totalTokens;
    usage.cost = usage.cost === null || !priced ? null : usage.cost + result.usage.cost.total;
  };
  let calls = 0;
  let truncated = false;
  let lastResponse: AssistantMessage | undefined;
  const billed: Promise<void>[] = [];
  const workerRuntime = new ModelRuntime();
  const { provider: _provider, baseUrl, ...definition } = model;
  workerRuntime.registerProvider(model.provider, {
    baseUrl,
    models: [definition],
    streamSimple: (selected, context, options) => {
      request.signal.throwIfAborted();
      if (++calls > maxWorkerCalls) throw new Error(`记忆整合超过 ${maxWorkerCalls} 次模型调用上限。`);
      const stream = runtime.streamSimple(selected, context, {
        ...options,
        signal: options?.signal ? AbortSignal.any([request.signal, options.signal]) : request.signal,
        // Let the existing provider layer clamp configured model output to remaining context.
        maxTokens: model.maxTokens,
        reasoning: toThinking(request.model.reasoning, model),
        maxRetries: 0,
        timeoutMs: 300_000,
      });
      billed.push(
        stream.result().then((result) => {
          lastResponse = result;
          if (result.stopReason === "length") truncated = true;
          recordUsage(result);
        }),
      );
      return stream;
    },
  });
  let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
  let abort = () => {};
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(new Error("记忆后台任务超过 15 分钟上限。")), workerTimeout);
  const signal = AbortSignal.any([request.signal, timeout.signal]);
  try {
    if (request.stage === "extract") {
      const context: Context = {
        messages: [
          { role: "system", content: request.instructions, timestamp: Date.now() },
          { role: "user", content: extractionInput(request, model), timestamp: Date.now() },
        ],
      };
      const result = await runtime
        .streamSimple(model, context, {
          signal,
          reasoning: toThinking(request.model.reasoning, model),
          maxTokens: model.maxTokens,
          maxRetries: 0,
          timeoutMs: 300_000,
          onPayload: extractionPayload,
        })
        .result();
      recordUsage(result);
      if (result.stopReason !== "stop" || result.content.some((part) => part.type === "toolCall"))
        throw new Error(
          `provider: 记忆提取未完成：${result.errorMessage || result.stopReason}；模型 ${model.provider}/${model.id}，配置输出上限 ${model.maxTokens}，本次输出 ${result.usage.output} tokens`,
        );
      signal.throwIfAborted();
      return { text: contentText(result.content, ""), usage };
    }
    const directory = request.directory;
    if (!directory) throw new Error("缺少记忆整合工作目录。");
    const root = resolve(directory);
    const readable = new Set(["memory_summary.md", ...(request.readFiles ?? [])]);
    const check = async (path: string, write = false) => {
      signal.throwIfAborted();
      const local = relative(root, resolve(root, path)).replaceAll("\\", "/");
      if (!readable.has(local) || (write && local !== "memory_summary.md"))
        throw new Error("记忆后台文件操作超出允许范围。");
      // Reject a replaced root or any symlink along the path. The worker has no shell or mkdir.
      let current = root;
      for (const segment of ["", ...local.split("/")]) {
        if (segment) current = resolve(current, segment);
        try {
          if ((await lstat(current)).isSymbolicLink()) throw new Error("记忆后台不允许符号链接。");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT" || current !== resolve(root, local))
            throw error;
        }
      }
      return resolve(root, local);
    };
    const readState = new FileReadState();
    const read = async (path: string) => readFile(await check(path));
    const write = async (path: string, content: string) => {
      const target = await check(path, true);
      if (Buffer.byteLength(content, "utf8") >= summaryLimit)
        throw new Error("长期记忆摘要必须小于 10,000 UTF-8 字节。");
      await replaceMemoryFile(target, content, signal);
    };
    ({ session } = await createAgentSession({
      cwd: root,
      agentDir: root,
      homeDir: root,
      modelRuntime: workerRuntime,
      model,
      thinkingLevel: toThinking(request.model.reasoning, model),
      sessionManager: SessionManager.inMemory(root),
      settingsManager: SettingsManager.inMemory({ retry: { enabled: false, provider: { maxRetries: 0 } } }),
      resourceLoader: { getBaseInstructions: () => request.instructions, getInstructions: () => [] },
      tools: ["read", "write", "edit"],
      toolOverrides: [
        createReadToolDefinition(root, {
          fileReadState: readState,
          operations: {
            readFile: read,
            access: async (path) => {
              await check(path);
            },
          },
        }),
        createWriteToolDefinition(root, {
          fileReadState: readState,
          operations: {
            writeFile: write,
            mkdir: async () => {
              signal.throwIfAborted();
              await lstat(root);
            },
          },
        }),
        createEditToolDefinition(root, {
          fileReadState: readState,
          operations: {
            readFile: read,
            writeFile: write,
            access: async (path) => {
              await check(path, true);
            },
          },
        }),
      ],
    }));
    abort = () => {
      void session?.abort();
    };
    signal.addEventListener("abort", abort, { once: true });
    signal.throwIfAborted();
    await session.prompt(request.prompt);
    signal.throwIfAborted();
    if (truncated)
      throw new Error(
        `provider: 记忆整合未完成：length；模型 ${model.provider}/${model.id}，配置输出上限 ${model.maxTokens}`,
      );
    // A truncated tool call or final reply can never complete the consolidation.
    const last = lastResponse ?? session.messages.findLast((message) => message.role === "assistant");
    if (last?.role !== "assistant" || last.stopReason !== "stop")
      throw new Error(
        `provider: 记忆整合未完成：${last?.role === "assistant" ? last.errorMessage || last.stopReason : "无结果"}；模型 ${model.provider}/${model.id}，配置输出上限 ${model.maxTokens}`,
      );
    return { text: contentText(last.content, ""), usage };
  } catch (error) {
    await Promise.allSettled(billed);
    throw Object.assign(error instanceof Error ? error : new Error(String(error)), { usage });
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
    await session?.abort();
    session?.dispose();
  }
}
