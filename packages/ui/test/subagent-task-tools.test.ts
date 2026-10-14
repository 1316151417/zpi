import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import { SubagentTaskToolBlock } from "../src/components/SubagentTaskToolBlock.tsx";
import { SubagentToolBlock } from "../src/components/SubagentToolBlock.tsx";
import type { ToolView } from "../src/components/tool-presentation.ts";
import { emptySession, reduceSession } from "../src/reducer.ts";
import type { SubagentTask } from "../src/types.ts";

const block: ToolView = {
  id: "b",
  messageId: "m",
  type: "tool",
  toolCallId: "call",
  name: "TaskOutput",
  argsText: '{"task_id":"agent_1"}',
  status: "completed",
  output: "",
};
const render = (fields: Partial<ToolView>) =>
  renderToStaticMarkup(
    createElement(SubagentTaskToolBlock, {
      block: { ...block, ...fields },
      expanded: true,
      toggle: () => {},
    }),
  );

test("Agent summaries localize the label without changing protocol or agent names", () => {
  for (const status of ["preparing", "running", "completed", "error"] as const) {
    for (const agentType of ["Explore", "general-purpose", "Custom helper"]) {
      const markup = renderToStaticMarkup(
        createElement(SubagentToolBlock, {
          block: {
            ...block,
            name: "Agent",
            status,
            argsText: JSON.stringify({ subagent_type: agentType, description: "Inspect source" }),
          },
          expanded: false,
          toggle: () => {},
        }),
      );
      expect(markup).toContain(">子智能体</strong>");
      expect(markup).not.toContain("SubAgent");
      expect(markup).toContain('data-tool-name="Agent"');
      expect(markup).toContain(agentType);
      expect(markup).toContain("Inspect source");
    }
  }
});

test.each([
  ["not_ready", "running", "运行中"],
  ["timeout", "running", "等待超时"],
  ["success", "completed", "已读取"],
  ["success", "aborted", "任务已停止"],
])("TaskOutput renders %s / %s without transport tags", (retrieval, status, label) => {
  const markup = render({
    output: `<retrieval_status>${retrieval}</retrieval_status>\n\n<task_id>agent_1</task_id>\n\n<task_type>local_agent</task_type>\n\n<status>${status}</status>\n\n<output>\nFound entry.ts\n</output>`,
  });
  expect(markup).toContain(label);
  expect(markup).toContain("Found entry.ts");
  expect(markup).not.toContain("retrieval_status");
});

test("TaskStop shows a compact description and surfaces failures", () => {
  const markup = render({
    name: "TaskStop",
    output: JSON.stringify({
      command: "Inspect source",
      message: "Task stopped.",
      task_id: "agent_1",
      task_type: "local_agent",
    }),
  });
  expect(markup).toContain("Inspect source");
  expect(markup).toContain("已停止");
  expect(markup).not.toContain("local_agent");
  const failed = render({ name: "TaskStop", status: "error", output: "Task no longer running" });
  expect(failed).toContain("执行失败");
  expect(failed).not.toContain("已停止");
});

test("XML examples in task output do not masquerade as task failures", () => {
  const markup = render({
    output:
      "<retrieval_status>success</retrieval_status>\n\n<task_id>agent_1</task_id>\n\n<task_type>local_agent</task_type>\n\n<status>completed</status>\n\n<output>\n<error>Example tag</error>\n</output>",
  });
  expect(markup).toContain("已读取");
  expect(markup).not.toContain("执行失败");
  expect(markup).toContain("Example tag");
});

test.each([
  ["completed", "已读取"],
  ["failed", "任务失败"],
  ["cancelled", "任务已停止"],
  ["lost", "任务已中断"],
])("TaskOutput renders background shell status %s and clean output", (status, label) => {
  const markup = render({
    argsText: '{"task_id":"exec_1"}',
    output: `<retrieval_status>success</retrieval_status>\n\n<task_id>exec_1</task_id>\n\n<task_type>local_bash</task_type>\n\n<status>${status}</status>\n\n<exit_code>0</exit_code>\n\n<output>\nServer ready\n</output>`,
  });
  expect(markup).toContain(label);
  expect(markup).toContain("Server ready");
  expect(markup).not.toContain("retrieval_status");
});

test("incremental agent updates preserve other tasks and conversation references", () => {
  const task: SubagentTask = {
    agentId: "a",
    childSessionId: "c",
    parentSessionId: "s",
    parentToolCallId: "t",
    agentType: "Explore",
    description: "Search",
    color: "cyan",
    background: true,
    status: "running",
    startedAt: 1,
    modelLabel: "test",
    totalTokens: 0,
    totalToolUseCount: 0,
  };
  const other = { ...task, agentId: "b" };
  const view = { ...emptySession("s"), subagents: [task, other] };
  const event = {
    sessionId: "s",
    runId: "subagents",
    seq: 1,
    event: {
      type: "subagent_changed" as const,
      task: { ...task, status: "completed" as const, result: "found" },
    },
  };
  const updated = reduceSession(view, event);
  expect(updated.subagents).toHaveLength(2);
  expect(updated.subagents?.[0].result).toBe("found");
  expect(updated.subagents?.[1]).toBe(other);
  expect(updated.runs).toBe(view.runs);
  expect(reduceSession(updated, event)).toBe(updated);
  expect(
    reduceSession(updated, {
      ...event,
      seq: 2,
      event: { type: "subagent_changed", task: { ...task, agentId: "new" } },
    }).subagents,
  ).toHaveLength(3);
});
