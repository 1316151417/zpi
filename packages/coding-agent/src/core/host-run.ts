import type { AssistantMessage, ImageContent, Model, SimpleStreamOptions } from "@zpi-dev/ai";
import type { AgentSession, InputContext } from "./agent-session.ts";
import type { ParsedInput } from "./commands.ts";
import type { ModelRuntime } from "./model-runtime.ts";
import { createAgentSession } from "./sdk.ts";
import { SessionManager } from "./session-manager.ts";
import { SettingsManager } from "./settings-manager.ts";
import { StaticResourceLoader } from "./types.ts";

/** Shared turn-outcome ladder: raw failure, then abort, then a failed or aborted assistant turn. */
function turnFailure(
  failure: unknown,
  signal: AbortSignal | undefined,
  terminal: AssistantMessage | undefined,
): Error | undefined {
  if (failure !== undefined) return failure instanceof Error ? failure : new Error(String(failure));
  if (signal?.aborted) return new Error("Query interrupted");
  if (terminal && (terminal.stopReason === "error" || terminal.stopReason === "aborted"))
    return new Error(terminal.errorMessage ?? terminal.stopReason);
  return undefined;
}

export interface SessionInputRun {
  session: AgentSession;
  sessionManager: SessionManager;
  input: { parsed: ParsedInput; context?: InputContext };
  signal?: AbortSignal;
}

/**
 * Execute one prepared input on a host-owned session and classify the outcome the way the
 * SDK turn loop does: persisted entries are flushed first, aborts surface as
 * "Query interrupted", and a failed or aborted assistant turn rethrows its stop reason.
 * The caller keeps session ownership, projection and disposal.
 */
export async function runSessionInput(run: SessionInputRun): Promise<void> {
  const { session, sessionManager, input, signal } = run;
  signal?.throwIfAborted();
  const abort = () => void session.abort();
  signal?.addEventListener("abort", abort, { once: true });
  let failure: unknown;
  const prior = session.messages.findLast((message) => message.role === "assistant");
  try {
    await session.executeInput(input.parsed, input.context ?? {});
  } catch (error) {
    failure = error;
  } finally {
    signal?.removeEventListener("abort", abort);
  }
  await sessionManager.flushAsync();
  const latest = session.messages.findLast((message) => message.role === "assistant");
  const error = turnFailure(failure, signal, latest !== prior ? latest : undefined);
  if (error) throw error;
}

export interface ModelExchangeOptions {
  runtime: ModelRuntime;
  model: Model;
  systemPrompt: string;
  prompt: string;
  images?: readonly ImageContent[];
  requestOptions?: SimpleStreamOptions;
  signal?: AbortSignal;
}

export interface ModelExchangeResult {
  /** Final assistant response, present even when the exchange did not complete cleanly. */
  message: AssistantMessage | undefined;
  /** Classified terminal failure; undefined when the model exchange completed. */
  error: Error | undefined;
}

/**
 * One no-tool model exchange in an isolated in-memory session: a single prepared prompt with
 * custom base instructions and request options, nothing persisted. The outcome always carries
 * the final assistant response when one exists; retries of the same request stay allowed, but
 * continuation requests after a response (for example hallucinated tool calls) fail instead of
 * looping.
 */
export async function runModelExchange(options: ModelExchangeOptions): Promise<ModelExchangeResult> {
  options.signal?.throwIfAborted();
  let session: AgentSession | undefined;
  const abortSession = () => void session?.abort();
  options.signal?.addEventListener("abort", abortSession, { once: true });
  let failure: unknown;
  try {
    const created = await createAgentSession({
      cwd: process.cwd(),
      modelRuntime: options.runtime,
      model: options.model,
      systemPrompt: options.systemPrompt,
      modelRequestOptions: () => options.requestOptions ?? {},
      beforeModelRequest: () => {
        if (session?.messages.some((message) => message.role === "assistant"))
          throw new Error("Model exchange exceeded its single response");
      },
      sessionManager: SessionManager.inMemory(),
      settingsManager: SettingsManager.inMemory({ retry: { enabled: false } }),
      resourceLoader: new StaticResourceLoader(),
      noTools: "all",
    });
    session = created.session;
    options.signal?.throwIfAborted();
    const images = options.images ? [...options.images] : [];
    const prepared = await session.prepareInput(options.prompt, { images });
    await session.executeInput(prepared, { images });
  } catch (error) {
    failure = error;
  } finally {
    options.signal?.removeEventListener("abort", abortSession);
    if (session) {
      await session.abort();
      session.dispose();
    }
  }
  // Prefer the model's actual output; engine bookkeeping after a guard failure or abort
  // appends error entries that must not shadow the exchanged response.
  const responses = session?.messages.filter((entry) => entry.role === "assistant") ?? [];
  const message =
    responses.findLast((entry) => entry.stopReason !== "error" && entry.stopReason !== "aborted") ??
    responses.at(-1);
  const error = turnFailure(failure, options.signal, responses.at(-1));
  return { message, error };
}
