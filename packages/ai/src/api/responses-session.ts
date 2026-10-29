import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { HttpsProxyAgent } from "https-proxy-agent";
import type OpenAI from "openai";
import type { ResponseStreamEvent } from "openai/resources/responses/responses";
import { ResponsesWS } from "openai/resources/responses/ws";
import { SocksProxyAgent } from "socks-proxy-agent";
import type { Model, StreamOptions } from "../types.ts";
import { isJsonObject } from "../utils/transcript.ts";

type Payload = Record<string, unknown> & { input: unknown[] };
type Previous = { id: string; settings: Record<string, unknown>; input: unknown[] };
const IDLE_MS = 5 * 60_000;
export interface ResponsesSessionOptions {
  /** Resolve a proxy URL, or undefined for a direct connection. Hosts can supply their system/PAC resolver. */
  resolveProxy?: (url: string) => Promise<string | undefined>;
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
  private disposed = false;
  private tail: Promise<void> = Promise.resolve();
  private options: ResponsesSessionOptions;
  constructor(options: ResponsesSessionOptions = {}) {
    this.options = options;
  }

  dispose(): void {
    this.disposed = true;
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
    await before;
    let completed = false;
    let progressed = false;
    let usingSocket = false;
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
        if (!options.responsesWarmup) yield* await http();
        completed = true;
        return;
      }
      options.signal?.addEventListener("abort", abort, { once: true });
      usingSocket = true;
      if (!this.socket) {
        this.previous = undefined;
        const proxy = await this.options.resolveProxy?.(model.baseUrl);
        options.signal?.throwIfAborted();
        if (this.disposed) throw new Error("Responses session disposed");
        const agent = proxy
          ? /^socks/.test(proxy)
            ? new SocksProxyAgent(proxy)
            : new HttpsProxyAgent(proxy)
          : undefined;
        this.socket = new ResponsesWS(client, { handshakeTimeout: 1500, perMessageDeflate: true, agent });
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
      }
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
      for (;;) {
        const socket = this.socket;
        if (!socket) throw new Error("Responses WebSocket closed");
        const iterator = socket.stream({ maxBufferedEvents: 4096 });
        let restart = false;
        try {
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
              if (parent && !progressed && code === "previous_response_not_found") {
                this.previous = undefined;
                parent = undefined;
                restart = true;
                break;
              }
              // Request/auth/usage errors belong to the caller, rather than a silent transport retry.
              if (
                detail &&
                ![
                  "websocket_not_supported",
                  "websockets_not_supported",
                  "unsupported_transport",
                  "websocket_connection_limit_reached",
                ].includes(code ?? "")
              )
                progressed = true;
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
                throw error;
              }
              options.signal?.throwIfAborted();
              if (this.disposed) throw new Error("Responses session disposed");
            }
            const event = record.message as ResponseStreamEvent;
            if (event.type === "response.completed") {
              try {
                this.previous = {
                  id: event.response.id,
                  settings: structuredClone(settings),
                  input: structuredClone([...payload.input, ...outputInput(event.response.output, model)]),
                };
              } catch {
                // Malformed tool arguments are diagnosed by the adapter; never replay a completed generation.
                this.previous = undefined;
              }
              completed = true;
            } else if (event.type === "response.incomplete") {
              this.previous = undefined;
              completed = true;
            } else if (
              !["response.created", "response.in_progress", "response.queued"].includes(event.type)
            ) {
              progressed = true;
            }
            yield event;
            if (completed) return;
          }
        } finally {
          await iterator.return?.();
        }
        if (!restart) throw new Error("Stream ended without response.completed");
      }
    } catch (error) {
      this.disconnect();
      if (options.responsesWarmup && !this.disposed) this.httpUntil = Date.now() + 60_000;
      if (options.signal?.aborted || this.disposed || progressed) throw error;
      // A blocked proxy/upgrade should cost one short attempt, not one attempt per tool call.
      this.httpUntil = Date.now() + 60_000;
      if (!options.responsesWarmup) {
        yield* await http();
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
