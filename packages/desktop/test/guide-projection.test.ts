import { expect, it } from "vitest";
import type { Message } from "zpi-ai";
import { SessionManager } from "zpi-coding-agent";
import { emptySession, mergeHistory, reduceSession } from "zpi-ui/projection";
import { conversationQueries } from "../../ui/src/conversation-run-partition.ts";
import { projectEvent, restoreView } from "../src/main/projection.ts";

it("projects only marked user guides and deduplicates them in live, restored and paged views", () => {
  const manager = SessionManager.inMemory();
  manager.appendCustomEntry("zpi.run", { phase: "start", runId: "r", text: "original", startedAt: 1 });
  let view = reduceSession(emptySession("s"), {
    sessionId: "s",
    runId: "r",
    seq: 1,
    event: { type: "started", text: "original", startedAt: 1, modelLabel: "fake" },
  });
  let seq = 1;
  const guide: Message = {
    role: "user",
    content: "PRIVATE_PREPARED_CONTEXT",
    timestamp: 2,
    inputId: "guide-1",
    userGuide: { text: "visible guide", fileReferences: ["file.ts"], attachments: [] },
  };
  for (const message of [
    { role: "user", content: "INTERNAL_NOTICE", inputId: "internal", timestamp: 1 } as Message,
    { ...guide, inputId: "synthetic", synthetic: true },
    guide,
    guide,
  ]) {
    manager.appendMessage(message);
    const event = projectEvent({ type: "message_end", message }, "r:2");
    if (event) view = reduceSession(view, { sessionId: "s", runId: "r", seq: ++seq, event });
  }
  const restored = restoreView("s", "test", manager.getEntries());
  for (const candidate of [view, restored, mergeHistory(view, restored)]) {
    expect(candidate.runs[0].guides).toHaveLength(1);
    expect(candidate.runs[0].guides?.[0]).toMatchObject({
      id: "guide-1",
      text: "visible guide",
      fileReferences: ["file.ts"],
    });
    expect(JSON.stringify(candidate)).not.toContain("PRIVATE_PREPARED_CONTEXT");
    expect(JSON.stringify(candidate)).not.toContain("INTERNAL_NOTICE");
    expect(conversationQueries(candidate.runs[0]).map((query) => query.key)).toEqual([
      "r:user",
      "r:guide:guide-1",
    ]);
  }
});
