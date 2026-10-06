import { emptyAssistant } from "ZPI-ai";
import { piTemplate, SessionManager } from "ZPI-coding-agent";
import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { fakeModel } from "./fake-server.ts";
export function seedHistory(
  dir: string,
  cwd: string,
  calls: number,
  options: {
    id?: string;
    perRun?: number;
    interrupted?: boolean;
    outputBytes?: number;
    projectId?: string | null;
  } = {},
) {
  const manager = SessionManager.create(
    cwd,
    join(dir, "agent", "sessions", options.projectId ?? "_unassigned"),
    { id: options.id ?? randomUUID() },
  );
  manager.appendSessionInfo("历史标题");
  manager.appendCustomEntry("ZPI.configuration", { template: { ...piTemplate }, disabledSkillPaths: [] });
  manager.appendCustomEntry("ZPI.session_meta", { projectId: options.projectId ?? null, pinnedAt: null });
  manager.appendCustomEntry("ZPI.title", { state: "legacy" });
  manager.appendModelChange("custom", "fake");
  manager.appendThinkingLevelChange("off");
  const file = manager.getSessionFile() as string;
  let parent = manager.getEntries().at(-1)?.id ?? null;
  const base = Date.now() - calls * 1000;
  const append = (fields: Record<string, unknown>, i: number) => {
    const entry = {
      ...fields,
      id: randomUUID(),
      parentId: parent,
      timestamp: new Date(base + i * 1000).toISOString(),
    };
    appendFileSync(file, `${JSON.stringify(entry)}\n`);
    parent = entry.id;
  };
  let runId = "",
    ordinal = 0;
  for (let i = 0; i < calls; i++) {
    if (i % (options.perRun ?? 1) === 0) {
      runId = `run-${i}`;
      ordinal = 0;
      append(
        {
          type: "custom",
          customType: "ZPI.run",
          data: {
            phase: "start",
            runId,
            text: `用户上下文 ${i}`,
            startedAt: base + i * 1000,
            modelLabel: "Fake",
            agentBoundaries: true,
          },
        },
        i,
      );
    }
    append({ type: "custom", customType: "ZPI.agent_call", data: { phase: "start", runId, ordinal } }, i);
    append(
      {
        type: "message",
        message: {
          role: "user",
          content: i ? `继续 ${i}` : "完整第一条用户上下文",
          timestamp: base + i * 1000,
        },
      },
      i,
    );
    ordinal++;
    const assistant = emptyAssistant({ ...fakeModel("http://127.0.0.1:1/v1"), provider: "custom" });
    const toolId = `tool-${i}`;
    append(
      {
        type: "message",
        message: {
          ...assistant,
          content: [
            { type: "thinking", thinking: `思考 ${i}` },
            { type: "toolCall", id: toolId, name: "read", arguments: { path: "README.md" } },
          ],
          stopReason: "toolUse",
          timestamp: base + i * 1000,
        },
      },
      i,
    );
    ordinal++;
    append(
      {
        type: "message",
        message: {
          role: "toolResult",
          toolCallId: toolId,
          toolName: "read",
          content: [{ type: "text", text: `工具结果 ${i}\n${"x".repeat(options.outputBytes ?? 0)}` }],
          isError: false,
          timestamp: base + i * 1000,
        },
      },
      i,
    );
    ordinal++;
    append(
      {
        type: "message",
        message: {
          ...assistant,
          content: [{ type: "text", text: `最终回复 ${i}\n\n${"历史验证 ".repeat(30)}` }],
          stopReason: "stop",
          timestamp: base + i * 1000,
        },
      },
      i,
    );
    ordinal++;
    if (!(options.interrupted && i === calls - 1)) {
      append({ type: "custom", customType: "ZPI.agent_call", data: { phase: "end", runId, ordinal } }, i);
      if ((i + 1) % (options.perRun ?? 1) === 0 || i === calls - 1)
        append(
          {
            type: "custom",
            customType: "ZPI.run",
            data: { phase: "end", runId, status: "completed", endedAt: base + i * 1000 + 20 },
          },
          i,
        );
    }
  }
  return { id: manager.getSessionId(), file };
}
