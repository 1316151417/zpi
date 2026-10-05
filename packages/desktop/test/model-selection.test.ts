import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { chunk, deferred, done, send } from "../../../tests/fake-server.ts";
import { SessionHost } from "../src/main/session-host.ts";
import { SettingsStore } from "../src/main/storage.ts";
import { cleanup, fixture } from "./helpers/host-fixture.ts";

it("medium, xhigh and max survive task reload and reach the provider unchanged; obsolete settings selections are cleared", async () => {
  const f = await fixture((_, response) => {
    send(response, chunk({ content: "ok" }));
    done(response);
  });
  const task = f.host.createSession(f.a.id);
  for (const reasoning of ["medium", "xhigh", "max"] as const) {
    await f.host.setSessionSelection(task.id, { provider: "custom", modelId: "fake", reasoning });
    await f.host.startRun({ sessionId: task.id, text: reasoning });
    await f.host.activeRuns.get(task.id)?.done;
    expect(f.server.requests.at(-1)?.reasoning_effort).toBe(reasoning);
    expect(f.host.getSessionSnapshot(task.id).controls?.thinkingLevel).toBe(reasoning);
  }
  await f.host.close();
  const file = join(f.dir, "settings.json");
  const old = JSON.parse(await readFile(file, "utf8"));
  old.lastSelection.reasoning = "disabled";
  await writeFile(file, JSON.stringify(old));
  const settings = new SettingsStore(f.dir, {
    isEncryptionAvailable: () => false,
    encryptString: () => Buffer.alloc(0),
    decryptString: () => "",
  });
  expect(settings.get().lastSelection).toBeNull();
  const host = new SessionHost(f.dir, settings, join(f.dir, "agent"), undefined, undefined, []);
  cleanup.push(() => host.close());
  await host.init();
  expect(host.getSessionSnapshot(task.id).controls?.selection?.reasoning).toBe("max");
  await host.startRun({ sessionId: task.id, text: "继续" });
  await host.activeRuns.get(task.id)?.done;
  expect(f.server.requests.at(-1)?.reasoning_effort).toBe("max");
});

it("running selection changes preserve old tool turns and use the new provider on the next message", async () => {
  const aStarted = deferred();
  const release = deferred();
  let first = true;
  const f = await fixture(async (body, response) => {
    const messages = body.messages as unknown as { role: string; content: string }[];
    const user = messages.find((m) => m.role === "user")?.content;
    if (user === "A" && first) {
      first = false;
      send(response, chunk({ content: "A start" }));
      aStarted.resolve();
      await release.promise;
      send(
        response,
        chunk({
          tool_calls: [
            { index: 0, id: "read", type: "function", function: { name: "read", arguments: '{"path":"x"}' } },
          ],
        }),
      );
      done(response, "tool_calls");
    } else {
      send(response, chunk({ content: "done" }));
      done(response);
    }
  });
  await writeFile(join(f.a.path, "x"), "old");
  const a = f.host.createSession(f.a.id),
    b = f.host.createSession(f.a.id);
  await f.host.startRun({ sessionId: a.id, text: "A" });
  await aStarted.promise;
  f.settings.saveProvider({
    id: "next-provider",
    name: "Next provider",
    baseUrl: f.server.url,
    apiKey: "new-key",
    models: [{ id: "new-model", input: ["text"], reasoning: false, contextWindow: 16384, maxTokens: 2048 }],
  });
  await f.host.setSessionSelection(a.id, {
    provider: "next-provider",
    modelId: "new-model",
    reasoning: "none",
  });
  expect(f.host.getSessionSnapshot(a.id).controls).toMatchObject({
    selection: { provider: "next-provider", modelId: "new-model", reasoning: "none" },
    selectionValid: true,
    usage: { contextWindow: 32768 },
  });
  expect(f.host.sessions.get(a.id)?.model.id).toBe("fake");
  await f.host.setSessionSelection(b.id, {
    provider: "next-provider",
    modelId: "new-model",
    reasoning: "none",
  });
  await f.host.startRun({ sessionId: b.id, text: "B" });
  const bRun = f.host.activeRuns.get(b.id);
  await bRun?.done;
  release.resolve();
  await f.host.activeRuns.get(a.id)?.done;
  expect(
    f.server.requests
      .filter((r) =>
        (r.messages as unknown as { role: string; content: string }[]).some(
          (m) => m.role === "user" && m.content === "A",
        ),
      )
      .map((r) => r.model),
  ).toEqual(["fake", "fake"]);
  expect(
    f.server.requests.find((r) =>
      (r.messages as unknown as { role: string; content: string }[]).some(
        (m) => m.role === "user" && m.content === "B",
      ),
    )?.model,
  ).toBe("new-model");
  const aRequests = f.server.requests.flatMap((request, index) =>
    request.model === "fake" ? [f.server.requestHeaders[index].authorization] : [],
  );
  expect(aRequests).toEqual(["Bearer secret-host", "Bearer secret-host"]);
  await f.host.startRun({ sessionId: a.id, text: "new message" });
  await f.host.activeRuns.get(a.id)?.done;
  expect(f.server.requests.at(-1)?.model).toBe("new-model");
  expect(f.server.requestHeaders.at(-1)?.authorization).toBe("Bearer new-key");
  await f.host.close();
  const restored = new SessionHost(f.dir, f.settings, join(f.dir, "agent"), undefined, undefined, []);
  await restored.init();
  cleanup.push(() => restored.close());
  expect(restored.getSessionSnapshot(a.id).controls.selection?.provider).toBe("next-provider");
});
