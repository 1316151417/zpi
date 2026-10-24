import { expect, it } from "vitest";
import type { AgentSession } from "zpi-coding-agent";
import type { SubagentTask } from "zpi-ui";
import { chunk, deferred, done, send } from "../../../tests/fake-server.ts";
import type { RunInput } from "../src/shared/bridge.ts";
import { fixture, run } from "./helpers/context-fixture.ts";

it("retains startup notifications during manual compaction until the next user interaction", async () => {
  const releaseSummary = deferred();
  const summaries: string[] = [];
  const f = await fixture(async (body, response) => {
    const messages = JSON.stringify(body.messages);
    if (messages.includes("ONLY output the structured summary")) {
      summaries.push(messages);
      await releaseSummary.promise;
      send(response, chunk({ content: "Earlier work summary" }));
    } else send(response, chunk({ content: `answer ${"completed work ".repeat(100)}` }));
    done(response);
  });
  await run(f, "first request");
  await run(f, "second request");
  const host = f.host as unknown as {
    sessions: Map<string, AgentSession>;
    pendingSubagentMessages: Map<string, RunInput[]>;
    deliverSubagentMessage(
      task: Pick<
        SubagentTask,
        "parentSessionId" | "agentId" | "agentType" | "description" | "status" | "result" | "error"
      >,
    ): Promise<void>;
  };
  const session = host.sessions.get(f.session.id);
  if (!session) throw new Error("missing SDK session");
  session.settingsManager.applyOverrides({ compaction: { keepRecentTokens: 20 } });
  const markers = ["STARTUP_RESULT_ONE", "STARTUP_RESULT_TWO"];
  const deliveries: Promise<void>[] = [];
  const off = f.host.subscribe(({ event }) => {
    if (event.type !== "started" || event.text !== "/compact") return;
    for (const marker of markers)
      deliveries.push(
        host.deliverSubagentMessage({
          parentSessionId: f.session.id,
          agentId: marker,
          agentType: "Explore",
          description: "Completed background work",
          status: "completed",
          result: marker,
        }),
      );
  });
  try {
    await f.host.startRun({ sessionId: f.session.id, text: "/compact" });
    await Promise.all(deliveries);
    expect(deliveries).toHaveLength(2);
    expect(host.pendingSubagentMessages.get(f.session.id)).toHaveLength(2);
    releaseSummary.resolve();
    while (f.host.activeRuns.has(f.session.id)) await f.host.activeRuns.get(f.session.id)?.done;
    expect(summaries.length).toBeGreaterThan(0);
    for (const marker of markers)
      expect(f.server.requests.some((request) => JSON.stringify(request.messages).includes(marker))).toBe(
        false,
      );
    expect(host.pendingSubagentMessages.get(f.session.id)).toHaveLength(2);
    await run(f, "Continue with findings");
    for (const marker of markers) {
      for (const summary of summaries) expect(summary).not.toContain(marker);
      expect(f.server.requests.some((request) => JSON.stringify(request.messages).includes(marker))).toBe(
        true,
      );
      expect(
        session.messages.filter(
          (message) => message.role === "user" && JSON.stringify(message.content).includes(marker),
        ),
      ).toHaveLength(1);
    }
    expect(host.pendingSubagentMessages.has(f.session.id)).toBe(false);
    expect(f.host.getSessionSnapshot(f.session.id).view.runs.at(-1)?.status).toBe("completed");
  } finally {
    releaseSummary.resolve();
    off();
  }
});
