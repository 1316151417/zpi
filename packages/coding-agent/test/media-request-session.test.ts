import { randomFillSync } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";
import { expect, it, vi } from "vitest";
import { createAssistantMessageEventStream, emptyAssistant, mediaRequestBytes } from "zpi-ai";
import {
  createAgentSession,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  StaticResourceLoader,
} from "zpi-coding-agent";
import { fakeConfig } from "../../../tests/fake-server.ts";
import { directory } from "./helpers/session-fixture.ts";

it("reads 42 screenshot files through a real session while bounding every provider request and logging the frontier", async () => {
  const cwd = await directory();
  const pixels = randomFillSync(Buffer.alloc(320 * 2400 * 3));
  const screenshot = await sharp(pixels, { raw: { width: 320, height: 2400, channels: 3 } })
    .png()
    .toBuffer();
  const paths = Array.from({ length: 42 }, (_, i) => join(cwd, `screenshot-${i}.png`));
  await Promise.all(paths.map((path) => writeFile(path, screenshot)));
  const manager = SessionManager.inMemory(cwd);
  // Existing long conversations can contain pre-fix, full-size images. They must also be safe.
  for (let i = 0; i < 15; i++)
    manager.appendMessage({
      role: "user",
      timestamp: i,
      content: [{ type: "image", data: screenshot.toString("base64"), mimeType: "image/png" }],
    });
  const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
  const runtime = new ModelRuntime();
  let requests = 0;
  let peakMediaBytes = 0;
  let peakBodyBytes = 0;
  let maxReadBase64Bytes = 0;
  runtime.registerProvider("fake", {
    models: [{ ...fakeConfig(""), input: ["text", "image"], contextWindow: 1_000_000 }],
    streamSimple(model, context) {
      const bytes = context.messages.reduce(
        (sum, message) =>
          sum +
          (typeof message.content === "string"
            ? 0
            : message.content.reduce((n, block) => n + mediaRequestBytes(block), 0)),
        0,
      );
      peakMediaBytes = Math.max(peakMediaBytes, bytes);
      const bodyBytes = Buffer.byteLength(JSON.stringify(context));
      peakBodyBytes = Math.max(peakBodyBytes, bodyBytes);
      expect(bytes).toBeLessThanOrEqual(40 * 1024 * 1024);
      expect(bodyBytes).toBeLessThan(50 * 1024 * 1024);
      for (const message of context.messages)
        if (message.role === "toolResult")
          for (const block of message.content)
            if (block.type === "image") {
              expect(block.data.length).toBeLessThanOrEqual(200_000);
              maxReadBase64Bytes = Math.max(maxReadBase64Bytes, block.data.length);
            }
      const response = emptyAssistant(model);
      if (requests < paths.length) {
        response.content = [
          { type: "toolCall", id: `read-${requests}`, name: "read", arguments: { path: paths[requests] } },
        ];
        response.stopReason = "toolUse";
      } else response.content = [{ type: "text", text: "42 screenshots inspected" }];
      requests++;
      const events = createAssistantMessageEventStream();
      events.end(response);
      return events;
    },
  });
  const { session } = await createAgentSession({
    cwd,
    agentDir: join(cwd, "agent"),
    homeDir: join(cwd, "home"),
    modelRuntime: runtime,
    sessionManager: manager,
    tools: ["read"],
    resourceLoader: new StaticResourceLoader(),
    settingsManager: SettingsManager.inMemory({ compaction: { enabled: false } }),
  });
  try {
    await session.prompt("Inspect each screenshot in order");
    expect(requests).toBe(43);
    expect(session.messages.at(-1)).toMatchObject({ stopReason: "stop" });
    expect(
      manager.getEntries().filter((entry) => entry.type === "message" && entry.message.role === "toolResult"),
    ).toHaveLength(42);
    const stats = debug.mock.calls.map((call) => call[1]);
    expect(stats.some((stat) => stat.omittedMediaCount > 0 && stat.evictionFrontier !== null)).toBe(true);
    expect(stats[0]).toEqual(
      expect.objectContaining({
        omittedMediaCount: expect.any(Number),
        retainedMediaCount: expect.any(Number),
        projectedMediaBytes: expect.any(Number),
        totalMediaBytes: expect.any(Number),
        evictionFrontier: { messageIndex: expect.any(Number), blockIndex: expect.any(Number) },
      }),
    );
    // Canonical history still includes all 15 legacy images and all 42 newly read images.
    expect(
      manager
        .getEntries()
        .filter((entry) => entry.type === "message")
        .flatMap((entry) => {
          const message = entry.type === "message" ? entry.message : undefined;
          return message && typeof message.content !== "string"
            ? message.content.filter((block) => block.type === "image")
            : [];
        }),
    ).toHaveLength(57);
    debug.mockRestore();
    process.stdout.write(
      `42-screenshot regression ${JSON.stringify({ requests, maxReadBase64Bytes, peakMediaBytes, peakBodyBytes, omittedMediaCount: stats[0].omittedMediaCount, evictionFrontier: stats[0].evictionFrontier })}\n`,
    );
  } finally {
    session.dispose();
    debug.mockRestore();
  }
}, 60_000);
