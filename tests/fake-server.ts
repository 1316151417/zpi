import type { JsonObject, Model } from "ZPI-ai";
import { once } from "node:events";
import type { IncomingHttpHeaders, ServerResponse } from "node:http";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
export function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
export function chunk(delta: unknown, finish_reason: string | null = null) {
  return {
    id: "fake-response",
    object: "chat.completion.chunk",
    created: 1,
    model: "fake",
    choices: [{ index: 0, delta, finish_reason }],
  };
}
export function send(response: ServerResponse, data: unknown): void {
  response.write(`data: ${JSON.stringify(data)}\n\n`);
}
export function done(response: ServerResponse, reason = "stop"): void {
  send(response, chunk({}, reason));
  response.end("data: [DONE]\n\n");
}
export async function fakeServer(
  handler: (body: JsonObject, response: ServerResponse, index: number) => void | Promise<void>,
  titleHandler?: (body: JsonObject, response: ServerResponse) => void | Promise<void>,
) {
  const requests: JsonObject[] = [];
  const titleRequests: JsonObject[] = [];
  const requestHeaders: IncomingHttpHeaders[] = [];
  const server = createServer(async (req, res) => {
    if (req.url !== "/v1/chat/completions") {
      res.writeHead(404).end();
      return;
    }
    let raw = "";
    for await (const c of req) raw += c;
    const body = JSON.parse(raw) as JsonObject;
    const isTitle =
      Array.isArray(body.messages) &&
      body.messages.some((row) => {
        if (!row || typeof row !== "object" || Array.isArray(row)) return false;
        return (
          (row.role === "system" || row.role === "developer") &&
          typeof row.content === "string" &&
          row.content.startsWith("ZPI_SESSION_TITLE:")
        );
      });
    const index = isTitle ? -1 : requests.push(body) - 1;
    if (!isTitle) requestHeaders.push({ ...req.headers });
    res.setHeader("content-type", "text/event-stream");
    res.setHeader("cache-control", "no-cache");
    res.setHeader("connection", "keep-alive");
    try {
      if (isTitle) {
        titleRequests.push(body);
        if (titleHandler) await titleHandler(body, res);
        else {
          const rows = body.messages as unknown as { role: string; content: string }[];
          const input = rows.find((m) => m.role === "user")?.content;
          const text = typeof input === "string" ? input.trim().replace(/\s+/g, " ") : "图片消息";
          const chars = Array.from(
            new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text),
            (p) => p.segment,
          );
          send(
            res,
            chunk({
              content: JSON.stringify({
                session_title: chars.length > 10 ? `${chars.slice(0, 10).join("")}…` : text,
              }),
            }),
          );
          done(res);
        }
      } else await handler(body, res, index);
    } catch (error) {
      res.destroy(error instanceof Error ? error : undefined);
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
    requests,
    titleRequests,
    requestHeaders,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}
export const fakeModel = (baseUrl: string): Model => ({
  id: "fake",
  name: "Fake model",
  provider: "fake",
  api: "openai-completions",
  baseUrl,
  input: ["text", "image"],
  reasoning: true,
  contextWindow: 32768,
  maxTokens: 4096,
  cost: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 0 },
});
export async function demoServer() {
  return fakeServer((body, response) => {
    const messages = body.messages as unknown as { role: string; content: unknown }[];
    const results = messages.filter((m) => m.role === "tool");
    const toolNames =
      (body.tools as unknown as { function: { name: string } }[] | undefined)?.map((t) => t.function.name) ??
      [];
    const tools = [
      { name: "read", arguments: { path: "README.md" } },
      { name: "write", arguments: { path: "demo.txt", content: "hello\n" } },
      { name: "edit", arguments: { path: "demo.txt", edits: [{ oldText: "hello", newText: "ZPI" }] } },
      { name: "bash", arguments: { command: "cat demo.txt" } },
    ].filter((t) => toolNames.includes(t.name));
    if (results.length < tools.length) {
      const t = tools[results.length];
      send(response, chunk({ reasoning_content: `执行 ${t.name}，验证工具闭环。\n` }));
      send(
        response,
        chunk({
          tool_calls: [
            {
              index: 0,
              id: `call-${results.length}`,
              type: "function",
              function: { name: t.name, arguments: JSON.stringify(t.arguments) },
            },
          ],
        }),
      );
      done(response, "tool_calls");
    } else {
      send(response, chunk({ content: "本地演示完成。" }));
      send(response, chunk({ content: `\n\n已收到 ${results.length} 个工具结果。` }));
      done(response);
    }
  });
}

export function fakeConfig(baseUrl: string) {
  const { provider: _, baseUrl: __, ...config } = fakeModel(baseUrl);
  return config;
}
