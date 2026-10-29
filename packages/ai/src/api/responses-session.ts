import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { HttpsProxyAgent } from "https-proxy-agent";
import type OpenAI from "openai";
import type { ResponseStreamEvent } from "openai/resources/responses/responses";
import { ResponsesWS } from "openai/resources/responses/ws";
import { SocksProxyAgent } from "socks-proxy-agent";
import { WebSocket } from "ws";
import type { Model, StreamOptions } from "../types.ts";
import { abortable } from "../utils/abort.ts";
import { isJsonObject } from "../utils/transcript.ts";

type Payload = Record<string, unknown> & { input: unknown[] };
type Previous = { id: string; settings: Record<string, unknown>; input: unknown[] };
const IDLE_MS = 5 * 60_000;
type FailureReason =
  | "connection_limit"
  | "previous_response_not_found"
  | "invalid_previous_response"
  | "closed_connection"
  | "transport"
  | "request_error"
  | "observer_error"
  | "aborted"
  | "disposed";
export interface ResponsesSessionStats {
  connectionsCreated: number;
  connectionsReused: number;
  websocketRequests: number;
  warmupRequests: number;
  fullContextRequests: number;
  deltaRequests: number;
  reconnects: number;
  websocketFailures: number;
  httpRequests: number;
  httpFallbacks: number;
  lastInputItems: number;
  lastFullInputItems: number;
}
export interface ResponsesSessionDiagnostic {
  event: "request" | "reconnect" | "fallback" | "complete" | "error";
  transport: "websocket" | "http";
  warmup: boolean;
  reason?: FailureReason;
  stats: ResponsesSessionStats;
}
export interface ResponsesSessionOptions {
  /** Resolve a proxy URL, or undefined for a direct connection. Hosts can supply their system/PAC resolver. */
  resolveProxy?: (url: string) => Promise<string | undefined>;
  /** Local counters only: no credentials, prompts, response IDs, or server error bodies. */
  onDiagnostic?: (diagnostic: ResponsesSessionDiagnostic) => void;
}

export function supportsResponsesWebSocket(model: Model): boolean {
  // Gateways retain their existing HTTP behavior; never forward official credentials to another endpoint.
  return model.api === "openai-responses" && /^https:\/\/api\.openai\.com\/v1\/?$/.test(model.baseUrl);
}

/** One conversation, one authenticated socket. Nothing here is persisted in the transcript. */
export class ResponsesSession {
  private socket?: ResponsesWS;
  private identity?: string;
  private previous?: Previous;
  private idle?: ReturnType<typeof setTimeout>;
  private openedAt = 0;
  private httpUntil = 0;
  private lifecycle = new AbortController();
  private tail: Promise<void> = Promise.resolve();
  private options: ResponsesSessionOptions;
  private stats: ResponsesSessionStats = {
    connectionsCreated: 0,
    connectionsReused: 0,
    websocketRequests: 0,
    warmupRequests: 0,
    fullContextRequests: 0,
    deltaRequests: 0,
    reconnects: 0,
    websocketFailures: 0,
    httpRequests: 0,
    httpFallbacks: 0,
    lastInputItems: 0,
    lastFullInputItems: 0,
  };
  constructor(options: ResponsesSessionOptions = {}) {
    this.options = options;
  }

  get diagnostics(): ResponsesSessionStats {
    return { ...this.stats };
  }

  private get disposed(): boolean {
    return this.lifecycle.signal.aborted;
  }

  private report(diagnostic: Omit<ResponsesSessionDiagnostic, "stats">): void {
    try {
      this.options.onDiagnostic?.({ ...diagnostic, stats: this.diagnostics });
    } catch {
      // Diagnostics must never change transport behavior or cause a generation to be replayed.
    }
  }

  dispose(): void {
    this.lifecycle.abort(new Error("Responses session disposed"));
    this.disconnect();
  }

  private disconnect(): void {
    clearTimeout(this.idle);
    this.previous = undefined;
    const socket = this.socket;
    this.socket = undefined;
    socket?.close();
  }

  async *events(
    client: OpenAI,
    model: Model,
    payload: Payload,
    options: StreamOptions,
    http: () => Promise<AsyncIterable<ResponseStreamEvent>>,
    start: () => void,
  ): AsyncGenerator<ResponseStreamEvent> {
    let release!: () => void;
    const before = this.tail;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    // Serialize warmup and generation, including callers that accidentally share a session concurrently.
    const signal = AbortSignal.any([this.lifecycle.signal, ...(options.signal ? [options.signal] : [])]);
    try {
      await abortable(before, signal);
    } catch (error) {
      // A cancelled waiter must not let later requests overtake the current owner.
      void before.then(release);
      throw error;
    }
    let completed = false;
    let progressed = false;
    let usingSocket = false;
    let failureReason: FailureReason = "transport";
    const report = (
      event: ResponsesSessionDiagnostic["event"],
      transport: ResponsesSessionDiagnostic["transport"],
      reason?: FailureReason,
    ) => this.report({ event, transport, warmup: !!options.responsesWarmup, reason });
    const httpEvents = async function* (session: ResponsesSession) {
      session.stats.httpRequests++;
      report("request", "http");
      try {
        for await (const event of await http()) {
          if (event.type === "response.completed" || event.type === "response.incomplete")
            report("complete", "http");
          yield event;
        }
      } catch (error) {
        report("error", "http", "transport");
        throw error;
      }
    };
    const abort = () => this.disconnect();
    try {
      options.signal?.throwIfAborted();
      if (this.disposed) throw new Error("Responses session disposed");
      const identity = createHash("sha256")
        .update(
          JSON.stringify([
            model.provider,
            model.id,
            model.auth,
            model.baseUrl,
            options.apiKey,
            model.headers,
            options.headers,
          ]),
        )
        .digest("hex");
      if (identity !== this.identity) {
        this.disconnect();
        this.identity = identity;
        this.httpUntil = 0;
      }
      if (Date.now() - this.openedAt > 55 * 60_000) this.disconnect();
      clearTimeout(this.idle);
      if (Date.now() < this.httpUntil) {
        if (!options.responsesWarmup) yield* httpEvents(this);
        completed = true;
        return;
      }
      options.signal?.addEventListener("abort", abort, { once: true });
      usingSocket = true;
      const settings: Record<string, unknown> = { ...payload };
      delete settings.input;
      delete settings.stream;
      delete settings.background;
      delete settings.previous_response_id;
      const previous = this.previous;
      const continuation =
        previous &&
        isDeepStrictEqual(settings, previous.settings) &&
        previous.input.length <= payload.input.length &&
        previous.input.every((item, index) => isDeepStrictEqual(item, payload.input[index]));
      let parent = continuation ? previous.id : undefined;
      let retried = false;
      for (;;) {
        let iterator: ReturnType<ResponsesWS["stream"]> | undefined;
        let recoverable: FailureReason | undefined;
        try {
          failureReason = "transport";
          // A close handshake may take seconds before the SDK emits its close event.
          if (this.socket && this.socket.socket.readyState >= WebSocket.CLOSING) {
            this.disconnect();
            this.stats.reconnects++;
            report("reconnect", "websocket", "closed_connection");
          }
          if (!this.socket) {
            this.previous = undefined;
            parent = undefined;
            const proxy = await abortable(
              Promise.resolve(this.options.resolveProxy?.(model.baseUrl)),
              AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
            );
            options.signal?.throwIfAborted();
            if (this.disposed) throw new Error("Responses session disposed");
            const agent = proxy
              ? /^socks/.test(proxy)
                ? new SocksProxyAgent(proxy)
                : new HttpsProxyAgent(proxy)
              : undefined;
            this.socket = new ResponsesWS(client, {
              handshakeTimeout: 10_000,
              perMessageDeflate: true,
              agent,
            });
            this.stats.connectionsCreated++;
            this.openedAt = Date.now();
            // An idle socket can fail when no request iterator is listening.
            this.socket.on("error", () => {});
            const socket = this.socket;
            socket.on("close", () => {
              if (this.socket === socket) {
                this.socket = undefined;
                this.previous = undefined;
              }
            });
          } else this.stats.connectionsReused++;
          const socket = this.socket;
          iterator = socket.stream({ maxBufferedEvents: 4096 });
          this.stats.websocketRequests++;
          if (options.responsesWarmup) this.stats.warmupRequests++;
          this.stats[parent ? "deltaRequests" : "fullContextRequests"]++;
          this.stats.lastFullInputItems = payload.input.length;
          this.stats.lastInputItems = parent
            ? payload.input.length - (previous?.input.length ?? 0)
            : payload.input.length;
          report("request", "websocket");
          start();
          socket.sendRaw(
            JSON.stringify({
              ...settings,
              type: "response.create",
              input: parent ? payload.input.slice(previous?.input.length) : payload.input,
              ...(parent ? { previous_response_id: parent } : {}),
              ...(options.responsesWarmup ? { generate: false } : {}),
            }),
          );
          let reported = false;
          for await (const record of iterator) {
            options.signal?.throwIfAborted();
            if (record.type === "error") {
              const detail = record.error.error;
              const body = detail && "error" in detail ? detail.error : detail;
              const code = body?.code;
              // The server may close the socket with either coded or uncoded parent errors.
              const invalidParent =
                parent &&
                detail &&
                "status" in detail &&
                detail.status === 400 &&
                /previous_response_id/i.test(body?.message ?? "") &&
                /invalid|not found|does not exist/i.test(body?.message ?? "");
              recoverable =
                code === "websocket_connection_limit_reached"
                  ? "connection_limit"
                  : parent && code === "previous_response_not_found"
                    ? "previous_response_not_found"
                    : invalidParent
                      ? "invalid_previous_response"
                      : undefined;
              const unsupported = [
                "websocket_not_supported",
                "websockets_not_supported",
                "unsupported_transport",
              ].includes(code ?? "");
              failureReason = recoverable ?? (detail && !unsupported ? "request_error" : "transport");
              // Request/auth/usage errors belong to the caller, rather than a silent transport retry.
              if (!recoverable && detail && !unsupported) progressed = true;
              throw Object.assign(record.error, {
                code,
                status: detail && "status" in detail ? detail.status : undefined,
              });
            }
            if (record.type === "close") throw new Error("Responses WebSocket closed");
            if (record.type !== "message") continue;
            if (!reported) {
              reported = true;
              try {
                await options.onResponse?.(
                  { status: 101, headers: { "x-zpi-transport": "websocket" } },
                  model,
                );
              } catch (error) {
                progressed = true;
                failureReason = "observer_error";
                throw error;
              }
              options.signal?.throwIfAborted();
              if (this.disposed) throw new Error("Responses session disposed");
            }
            const event = record.message as ResponseStreamEvent;
            if (event.type === "response.completed") {
              try {
                const hasResponse =
                  options.responsesWarmup ||
                  event.response.output.length > 0 ||
                  (event.response.usage?.total_tokens ?? 0) > 0;
                this.previous = hasResponse
                  ? {
                      id: event.response.id,
                      settings: structuredClone(settings),
                      input: structuredClone([
                        ...payload.input,
                        ...outputInput(event.response.output, model),
                      ]),
                    }
                  : undefined;
              } catch {
                // Malformed tool arguments are diagnosed by the adapter; never replay a completed generation.
                this.previous = undefined;
              }
              completed = true;
            } else if (event.type === "response.incomplete") {
              this.previous = undefined;
              completed = true;
            } else if (
              /^response\.(?:output_|reasoning_|function_call_arguments\.|refusal\.)/.test(event.type)
            ) {
              // Transport metadata/heartbeats do not mean model output has started.
              progressed = true;
            }
            if (completed) report("complete", "websocket");
            yield event;
            if (completed) return;
          }
          throw new Error("Stream ended without response.completed");
        } catch (error) {
          if (!options.signal?.aborted && !this.disposed) this.stats.websocketFailures++;
          if (recoverable && !retried && !progressed && !options.signal?.aborted && !this.disposed) {
            this.disconnect();
            parent = undefined;
            retried = true;
            this.stats.reconnects++;
            report("reconnect", "websocket", recoverable);
          } else throw error;
        } finally {
          await iterator?.return?.();
        }
      }
    } catch (error) {
      this.disconnect();
      if (options.responsesWarmup && !this.disposed) this.httpUntil = Date.now() + 60_000;
      if (!usingSocket) throw error;
      if (options.signal?.aborted || this.disposed || progressed) {
        report(
          "error",
          "websocket",
          options.signal?.aborted ? "aborted" : this.disposed ? "disposed" : failureReason,
        );
        throw error;
      }
      // A blocked proxy/upgrade should cost one short attempt, not one attempt per tool call.
      this.httpUntil = Date.now() + 60_000;
      this.stats.httpFallbacks++;
      report("fallback", "http", failureReason);
      if (!options.responsesWarmup) {
        yield* httpEvents(this);
        completed = true;
      }
    } finally {
      options.signal?.removeEventListener("abort", abort);
      if (usingSocket && !completed) this.disconnect();
      if (this.socket) {
        this.idle = setTimeout(() => this.disconnect(), IDLE_MS);
        this.idle.unref();
      }
      release();
    }
  }
}

/** Compare with the portable transcript projection, not with the server's different output item shape. */
function outputInput(items: unknown[], model: Model): unknown[] {
  return items.flatMap((item): unknown[] => {
    if (!isJsonObject(item)) return [];
    if (item.type === "reasoning") return [item];
    if (item.type === "message" && Array.isArray(item.content))
      return item.content.flatMap((part) => {
        if (!isJsonObject(part)) return [];
        const text = part.type === "output_text" ? part.text : part.refusal;
        return typeof text === "string" && text.trim()
          ? [{ role: "assistant", content: text, ...(item.phase ? { phase: item.phase } : {}) }]
          : [];
      });
    if (item.type === "function_call")
      return [
        {
          type: "function_call",
          call_id: item.call_id,
          ...(item.id ? { id: item.id } : {}),
          name: item.name,
          arguments: JSON.stringify(JSON.parse(String(item.arguments || "{}"))),
          ...(model.auth === "chatgpt"
            ? { namespace: "ZPI" }
            : item.namespace
              ? { namespace: item.namespace }
              : {}),
        },
      ];
    return [];
  });
}
