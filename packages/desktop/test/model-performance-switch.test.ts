import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { reduceSession } from "@zpi-dev/ui";
import { expect, it } from "vitest";
import { chunk, deferred } from "../../../tests/fake-server.ts";
import { SessionHost } from "../src/main/session-host.ts";
import { SettingsStore } from "../src/main/storage.ts";
import { cleanup } from "./helpers/host-fixture.ts";

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "zpi-performance-switch-"));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const cwd = join(dir, "workspace");
  await mkdir(cwd);
  const codec = {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(s),
    decryptString: (b: Buffer) => b.toString(),
  };
  const settings = new SettingsStore(dir, codec);
  cleanup.push(async () => settings.close());
  settings.setPluginEnabled("zpi.memory", false);
  settings.setPluginEnabled("zpi.session-title", false);
  for (const provider of ["openai", "domestic"])
    settings.saveProvider({
      id: provider,
      name: provider,
      baseUrl: provider === "openai" ? "https://api.openai.com/v1" : "https://domestic.test/v1",
      ...(provider === "openai" ? { preset: "openai-chatgpt" as const } : { apiKey: "fake-domestic" }),
      models: [
        {
          id: provider,
          name: provider,
          input: ["text"],
          reasoning: true,
          compat: { supportsReasoningEffort: true },
        },
      ],
    });
  settings.saveChatGPTCredential("openai", {
    access: "fake-subscription",
    refresh: "fake-refresh",
    clientId: "fake-client",
    subject: "fake-subject",
    idToken: "fake-id",
    scopes: ["chatgpt.tokens.use.direct"],
    expires: Date.now() + 3600000,
  });
  const held = deferred(),
    release = deferred();
  cleanup.push(async () => release.resolve());
  const fetcher: typeof fetch = async (url, options) => {
    const responses = String(url).endsWith("/responses");
    const body = JSON.parse(String(options?.body));
    const serialized = JSON.stringify(responses ? body.input : body.messages);
    const burst = serialized.includes("burst");
    const hold = serialized.includes("hold");
    const frames = responses
      ? [
          {
            type: "response.reasoning_summary_text.delta",
            item_id: "rs",
            summary_index: 0,
            delta: "summary",
          },
          ...Array.from({ length: 4 }, () => ({
            type: "response.output_text.delta",
            item_id: "text",
            content_index: 0,
            delta: "text ".repeat(20),
          })),
          {
            type: "response.completed",
            response: {
              id: "response",
              model: "openai",
              status: "completed",
              output: [],
              usage: {
                input_tokens: 10,
                output_tokens: 140,
                total_tokens: 150,
                output_tokens_details: { reasoning_tokens: 40 },
              },
            },
          },
        ]
      : [
          chunk({ reasoning_content: "plan" }),
          ...Array.from({ length: 4 }, () => chunk({ content: "text ".repeat(20) })),
          {
            ...chunk({}),
            choices: [],
            usage: {
              prompt_tokens: 10,
              completion_tokens: 200,
              total_tokens: 210,
              completion_tokens_details: { reasoning_tokens: 50 },
            },
          },
          chunk({}, "stop"),
        ];
    return new Response(
      new ReadableStream({
        async start(controller) {
          for (const [i, frame] of frames.entries()) {
            if (!burst) await delay(110);
            controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(frame)}\n\n`));
            if (hold && i === 1) {
              held.resolve();
              await release.promise;
            }
          }
          controller.close();
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    );
  };
  const open = async () => {
    const host = new SessionHost(dir, new SettingsStore(dir, codec), dir, cwd, fetcher);
    cleanup.push(() => host.close());
    await host.init();
    return host;
  };
  const host = await open();
  const task = await host.createSession(null, { cwd });
  const select = (owner: SessionHost, provider: string) =>
    owner.setSessionSelection(task.id, { provider, modelId: provider, reasoning: "high" });
  const run = async (owner: SessionHost, text: string) => {
    await owner.startRun({ sessionId: task.id, text });
    await owner.activeRuns.get(task.id)?.done;
    const view = owner.getSessionSnapshot(task.id).view;
    expect(view.runs.at(-1)?.status).toBe("completed");
    return view.modelPerformance;
  };
  return { host, open, task, select, run, held, release };
}

it.each([
  ["openai", "domestic"],
  ["domestic", "openai"],
])(
  "%s → %s preserves cumulative usage and isolates timings during and after an active run",
  async (first, second) => {
    const f = await fixture();
    await f.select(f.host, first);
    expect(await f.run(f.host, "paced")).toMatchObject({
      turns: 1,
      steps: 1,
      modelLabel: first,
      speedSampleCount: 1,
    });
    let projected = f.host.getSessionSnapshot(f.task.id).view;
    const off = f.host.subscribe((e) => {
      projected = reduceSession(projected, e);
    });
    cleanup.push(async () => off());
    const changed = await f.select(f.host, second);
    expect(changed.view.modelPerformance?.modelLabel).toBeUndefined();
    expect(projected.modelPerformance?.modelLabel).toBeUndefined();
    const secondStats = await f.run(f.host, "paced");
    expect(secondStats).toMatchObject({
      turns: 2,
      steps: 2,
      modelLabel: second,
      speedSampleCount: 1,
      outputTokens: 340,
    });
    expect(secondStats?.tokensPerSecond).toBeGreaterThan(0);
    expect(secondStats?.firstTextMs).toBeGreaterThan(secondStats?.ttftMs ?? 0);
    await f.select(f.host, first);
    await f.host.startRun({ sessionId: f.task.id, text: "hold" });
    const active = f.host.activeRuns.get(f.task.id);
    await f.held.promise;
    await f.select(f.host, second);
    f.release.resolve();
    await active?.done;
    const afterOldRun = f.host.getSessionSnapshot(f.task.id).view.modelPerformance;
    expect(afterOldRun).toMatchObject({
      modelLabel: second,
      speedSampleCount: 1,
      requestMs: secondStats?.requestMs,
      ttftMs: secondStats?.ttftMs,
      tokensPerSecond: secondStats?.tokensPerSecond,
    });
    expect(projected.modelPerformance).toEqual(afterOldRun);
    const restoredFirst = await f.select(f.host, first);
    expect(restoredFirst.view.modelPerformance).toMatchObject({ modelLabel: first, speedSampleCount: 2 });
    const burst = await f.run(f.host, "burst");
    expect(burst?.requestTokensPerSecond).toBeUndefined();
    expect(burst).toMatchObject({ modelLabel: first, speedSampleCount: 2, turns: 4, steps: 4 });
    await f.host.close();
    const restarted = await f.open();
    expect(restarted.getSessionSnapshot(f.task.id).view.modelPerformance).toEqual(burst);
    const otherAfterRestart = await f.select(restarted, second);
    expect(otherAfterRestart.view.modelPerformance).toMatchObject({
      modelLabel: second,
      speedSampleCount: 1,
      requestMs: secondStats?.requestMs,
    });
    const child = await restarted.createSideChat(f.task.id);
    const inherited = restarted.getSessionSnapshot(child.id).view.modelPerformance;
    expect(inherited).toMatchObject({ turns: 4, steps: 4 });
    expect(inherited?.tokensPerSecond).toBeUndefined();
  },
);
