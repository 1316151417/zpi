import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join, relative } from "node:path";
import { emptyAssistant } from "zpi-ai";
import { piTemplate, type SessionEntry } from "zpi-coding-agent";
import { fakeModel } from "../../../../tests/fake-server.ts";
import { HistoryIndex } from "../../src/main/history-index.ts";
import type { StateStore } from "../../src/main/state-store.ts";
import { defaultCapabilities } from "../../src/shared/config.ts";
export function seedHistory(
  state: StateStore,
  dir: string,
  cwd: string,
  calls: number,
  options: {
    id?: string;
    perRun?: number;
    interrupted?: boolean;
    outputBytes?: number;
    projectId?: string | null;
    createdAt?: number;
    updatedAt?: number;
  } = {},
) {
  const id = options.id ?? randomUUID();
  const root = join(dir, "agent", "sessions", options.projectId ?? "_unassigned");
  mkdirSync(root, { recursive: true });
  const file = join(root, `${id}.jsonl`);
  const index = HistoryIndex.create(file, state.db, {
    type: "session",
    format: "zpi",
    version: 2,
    id,
    cwd,
    timestamp: new Date().toISOString(),
  });
  state.upsertTask({
    id,
    projectId: options.projectId ?? null,
    title: "历史标题",
    draft: false,
    createdAt: options.createdAt ?? Date.now(),
    updatedAt: options.updatedAt ?? Date.now(),
    status: options.interrupted ? "running" : "completed",
    cwd,
    sessionFile: relative(dir, file),
    currentSelection: { provider: "custom", modelId: "fake", reasoning: "none" },
    frozenConfiguration: { template: { ...piTemplate }, disabledSkillPaths: [], ...defaultCapabilities },
  });
  let parent: string | null = null;
  const base = Date.now() - calls * 1000;
  const append = (fields: Record<string, unknown>, i: number) => {
    const entry = {
      ...fields,
      id: randomUUID(),
      parentId: parent,
      timestamp: new Date(base + i * 1000).toISOString(),
    };
    index.append(entry as SessionEntry);
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
          customType: "zpi.run",
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
    append({ type: "custom", customType: "zpi.agent_call", data: { phase: "start", runId, ordinal } }, i);
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
      append({ type: "custom", customType: "zpi.agent_call", data: { phase: "end", runId, ordinal } }, i);
      if ((i + 1) % (options.perRun ?? 1) === 0 || i === calls - 1)
        append(
          {
            type: "custom",
            customType: "zpi.run",
            data: { phase: "end", runId, status: "completed", endedAt: base + i * 1000 + 20 },
          },
          i,
        );
    }
  }
  return { id, file };
}
