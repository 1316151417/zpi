// Adapted from ZCode tool handlers and subagent prompts (Apache-2.0).
// Delegation guidance also draws on Codex. Differences are recorded in docs/internals/subagents.md.
export const agentDescription =
  "Launch a new agent to handle complex, multi-step tasks. Each agent type has specific capabilities and tools available to it.\n\nAvailable agent types are listed in <system-reminder> messages in the conversation.\n\nWhen using the Agent tool, specify a subagent_type parameter to select which agent type to use. If omitted, the general-purpose agent is used.\n\n## When to use\n\nReach for this when the task matches an available agent type, when you have independent work to run in parallel, or when answering would mean reading across several files — delegate it and you keep the conclusion, not the file dumps. For a single-fact lookup where you already know the file, symbol, or value, search directly. Once you've delegated a search, don't also run it yourself — wait for the result.\n\n- The agent's final message is returned to you as the tool result; it is not shown to the user — relay what matters.\n- Use SendMessage with the agent's ID to continue a previously spawned agent with its context intact; a new Agent call starts fresh.\n- Each agent type's model, reasoning effort, and tools come from its definition (`.zpi/agents/*.md` frontmatter).\n- `run_in_background: true` runs the agent asynchronously; you'll be notified when it completes.";

export const codexAgentDescription = `Spawn a subagent for a well-scoped task. Its final message is returned to you as the tool result; relay relevant findings to the user. Available agent types are listed in <system-reminder> messages. Use subagent_type to choose a type; if omitted, general-purpose is used. Each type's model, reasoning effort, and tools come from its definition (.zpi/agents/*.md frontmatter).

Do not launch subagents unless the user or applicable AGENTS.md/skill instructions explicitly ask for subagents, delegation, or parallel agent work.
Requests for depth, thoroughness, research, investigation, or detailed codebase analysis do not count as permission to launch.
Agent-role guidance only helps choose which agent to use after delegation is already authorized; it never authorizes launching by itself.

### When to delegate vs. do the subtask yourself
- First, quickly analyze the overall user task and form a succinct high-level plan. Identify which tasks are immediate blockers on the critical path, and which tasks can run in parallel without blocking the next local step. Explicitly decide what immediate task you should do locally right now. Do this before delegating so you do not hand off the immediate blocking task and then waste time waiting on it.
- Use a subagent when a subtask is suitable for it to handle and can run in parallel with your local work. Prefer concrete, bounded tasks that materially advance the main task without blocking your immediate next local step.
- Do not delegate urgent blocking work when your immediate next step depends on that result. If the very next action is blocked on that task, the main agent should usually do it locally to keep the critical path moving.
- Keep work local when the subtask is too difficult to delegate well and when it is tightly coupled, urgent, or likely to block your immediate next step.

### Designing delegated subtasks
- Subtasks must be concrete, well-defined, and self-contained.
- Delegated subtasks must materially advance the main task.
- Do not duplicate work between the main agent and delegated subtasks.
- Avoid issuing multiple delegate calls on the same unresolved task unless the new delegated task is genuinely different and necessary.
- Narrow the delegated ask to the concrete output you need next.
- For coding tasks, prefer concrete implementation subtasks over read-only exploration when the subagent can make a bounded patch in a clear write scope.
- When delegating coding work, instruct the subagent to edit files directly in the shared workspace and list the file paths it changed in its final answer.
- For code-edit subtasks, assign disjoint file ownership; agents share the workspace.

### After you delegate
- For independent parallel work, set run_in_background: true. Completion notifications arrive automatically.
- Use blocking TaskOutput very sparingly. Wait only when you need the result immediately for the next critical-path step and are blocked until it returns.
- Do not redo delegated tasks yourself; focus on integrating results or tackling non-overlapping work.
- While the subagent is running in the background, do meaningful non-overlapping work immediately.
- Do not repeatedly wait or poll by reflex.
- When a delegated coding task returns, review the changes, then integrate or refine them.
- Use SendMessage with the existing agentId for related follow-up work; a new Agent call starts fresh.

### Parallel delegation patterns
- Run multiple independent information-seeking subtasks in parallel when you have distinct questions that can be answered independently.
- Split implementation into disjoint codebase slices and launch multiple agents for them in parallel when the write scopes do not overlap.
- Delegate verification only when it can run in parallel with ongoing implementation and is likely to catch a concrete risk before final integration.
- Find opportunities for independent subtasks within the same round, while ensuring each is well-defined, self-contained, and materially advances the main task.`;

export const sendMessageDescription =
  '# SendMessage\n\nSend a message to another agent.\n\n```json\n{"to": "agent_<uuid>", "summary": "assign task 1", "message": "start on task #1"}\n```\n\nYour plain text output is NOT visible to other agents — to communicate, you MUST call this tool. Messages from agents are delivered automatically; you don\'t check an inbox. Refer to local agents by the `agentId` returned in the Agent spawn result. To resume a completed agent, use its `agentId`; it resumes in the background and you\'ll be notified when it finishes.';

export const respondToCoordinatorDescription =
  'Respond to the coordinator that owns this subagent.\n\nUsage:\n- When you receive "The coordinator sent a message while you were working:" (or the legacy "Message from coordinator:" prefix), use this tool to answer it.\n- Use this tool for a concise response or progress update to the coordinator.\n- When replying while work remains, do not use assistant text as the reply.\n- Place this call before or alongside the next work tool call when possible.\n- Continue the current task unless the coordinator explicitly changed or ended it.\n- Do not use this tool as a substitute for the final task result.';

export const subagentCommonNotes =
  'Notes:\n- Agent threads always have their cwd reset between bash calls, as a result please only use absolute file paths.\n- In your final response, share file paths (always absolute, never relative) that are relevant to the task. Include code snippets only when the exact text is load-bearing (e.g., a bug you found, a function signature the caller asked for) — do not recap code you merely read.\n- For clear communication with the user the assistant MUST avoid using emojis.\n- Do not use a colon before tool calls. Text like "Let me read the file:" followed by a read tool call should just be "Let me read the file." with a period.\n- Do NOT write report/summary/findings/analysis .md files. Return findings directly as your final assistant message — the parent agent reads your text output, not files you create.';

export const agentConcurrencyNote =
  "When you launch multiple agents for independent work, send them in a single message with multiple tool uses so they run concurrently.";
