import { createServer } from "node:http";
import { text } from "node:stream/consumers";

// Exercise zpi's actual transports via an isolated loopback provider.
export async function testProvider() {
  const requests = [];
  const server = createServer(async (req, res) => {
    try {
      if (req.method === "GET" && req.url.includes("/models")) {
        res.writeHead(req.url.startsWith("/manual") ? 404 : 200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            data: ["coder", "org/writer"].map((id) => ({
              id,
              context_window: 32768,
              max_output_tokens: 4096,
              service_tiers: id === "coder" ? ["priority"] : [],
            })),
          }),
        );
        return;
      }
      const body = JSON.parse(await text(req));
      requests.push({
        injectedHeader: req.headers["x-unbound-header"],
        url: req.url,
        body,
        authorization: req.headers.authorization ?? req.headers["x-api-key"],
      });
      const messages = body.messages ?? [];
      const lastUser = messages.findLastIndex((m) => m.role === "user");
      const question =
        typeof messages[lastUser]?.content === "string"
          ? messages[lastUser].content
          : JSON.stringify(messages[lastUser]?.content ?? body.input ?? "");
      const calls =
        body.tools?.length && question.includes("exercise-tools")
          ? [
              ["write", { path: "demo.txt", content: "before\n" }],
              ["read", { path: "demo.txt" }],
              ["edit", { path: "demo.txt", edits: [{ oldText: "before", newText: "after" }] }],
              ["bash", { command: "cat demo.txt > proof.txt" }],
            ]
          : [];
      const index = messages.slice(lastUser + 1).filter((m) => m.role === "tool").length;
      const call = calls[index];
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
      res.flushHeaders();
      if (question.includes("hold-this-request")) return;
      const reply = `answer-${body.model}`;
      const send = (event) =>
        res.write(`${event.type ? `event: ${event.type}\n` : ""}data: ${JSON.stringify(event)}\n\n`);
      if (req.url.includes("/chat/completions")) {
        const chunk = (delta, finish_reason = null) =>
          send({
            id: "msg-test",
            model: body.model,
            object: "chat.completion.chunk",
            choices: [{ index: 0, delta, finish_reason }],
          });
        if (call) {
          chunk({
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: `call_${index}`,
                type: "function",
                function: { name: call[0], arguments: JSON.stringify(call[1]) },
              },
            ],
          });
          chunk({}, "tool_calls");
        } else {
          if (question.includes("show-thinking")) chunk({ reasoning_content: "检查终端回放" });
          chunk({ role: "assistant", content: reply });
          chunk({}, "stop");
        }
        res.write("data: [DONE]\n\n");
      } else if (req.url.includes("/responses")) {
        send({ type: "response.output_text.delta", item_id: "item1", content_index: 0, delta: reply });
        send({
          type: "response.completed",
          response: { id: "resp1", status: "completed", output: [], usage: null },
        });
      } else if (req.url.includes("/messages")) {
        send({
          type: "message_start",
          message: { id: "msg1", model: body.model, usage: { input_tokens: 1, output_tokens: 0 } },
        });
        send({ type: "content_block_start", index: 0, content_block: { type: "text", text: reply } });
        send({ type: "content_block_stop", index: 0 });
        send({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } });
        send({ type: "message_stop" });
      }
      res.end();
    } catch {
      res.destroy();
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    requests,
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
