# @zpi-dev/agent-sdk

TypeScript SDK for the ZPI agent runtime. Node.js 24 is required. Its supported API follows the [Claude Agent SDK TypeScript reference](https://code.claude.com/docs/zh-CN/agent-sdk/typescript); it runs ZPI directly and does not require Claude Code or an Anthropic subscription.

```ts
import { query } from "@zpi-dev/agent-sdk";

for await (const message of query({
  prompt: "Read package.json and explain this project",
  options: {
    model: "deepseek",
    tools: ["Read"],
    allowedTools: ["Read"],
    maxTurns: 8,
  },
})) {
  if (message.type === "result" && message.subtype === "success") {
    console.log(message.result);
  }
}
```

Set `DEEPSEEK_API_KEY` for the example. `model` accepts a registered provider, model ID, or `provider/model`. Anthropic requires `ANTHROPIC_API_KEY` and an explicit model ID (`options.model` or `ANTHROPIC_MODEL`). Additional providers, pricing, fetch implementations and existing host services can be supplied under the `zpi` namespace. Credentials are never supplied to the renderer by the SDK.

## Supported contract

| Area | Supported surface |
| --- | --- |
| Query | `query({ prompt, options })`, string or `AsyncIterable<SDKUserMessage>` input; `system`, `user`, `assistant`, `stream_event`, `result` messages |
| Conversation | In-memory or persisted sessions; `resume`, `continue`, `forkSession`, `resumeSessionAt`, session listing/history/title/tag APIs |
| Tools | `tools`, `allowedTools`, `disallowedTools`, `canUseTool`; canonical `Read`, `Write`, `Edit`, `Bash`, `Skill`, `Agent`, `TaskOutput`, `TaskStop` |
| Reserved tools | `Glob` and `Grep` retain their names and parameter schemas; execution throws `Error("暂不支持")` until implemented |
| Controls | `interrupt`, `close`, `setModel`, `setMaxThinkingTokens`, supported command/model/agent discovery, initialization result |
| Limits | `maxTurns`, `maxBudgetUsd`, `thinking`, `effort`, `maxThinkingTokens`, abort signals |
| Output | Partial streaming, usage/cost/model totals, JSON schema validation with up to three attempts |
| Hooks | TypeScript callbacks for session start/end, prompt submit, pre/post tool, tool failure, stop, subagent start/stop, pre/post compaction |
| Resources | Explicit local plugins: command hooks, prompt commands, skills, Agent markdown definitions. `settingSources` explicitly opts into user/project/local instruction and skill discovery |
| Files | Opt-in `enableFileCheckpointing` and `rewindFiles`, with external edit checks |

`tools` chooses which tools the model sees. `allowedTools` pre-approves matching calls; it does not hide other tools. `disallowedTools` wins over allow rules. A bare deny removes a tool from the model's context; an argument-qualified deny checks calls. Other calls go to `canUseTool`, or execute directly when no callback is configured. This embedded runtime has no interactive permission dialog and is not a sandbox. Configure `tools: []` for text/image chat without local capabilities. Tool results use canonical parameter names such as `file_path` and `tool_use_id`.

`systemPrompt` replaces the default base instructions. Resources, skill catalogs and plugin context are managed independently as named blocks; changes append replacement or withdrawal notices at their conversation position. The `claude_code` preset selects ZPI's coding assistant prompt, not Anthropic's proprietary prompt. Default `settingSources` is empty. Only explicitly supplied local plugins execute command hooks; adding a plugin authorizes its code in the host process environment. Agent model aliases must resolve to registered models. `forwardSubagentText` defaults to false. Background tasks belong to their parent Query and are cancelled when it closes.

Pricing is provider configuration. Environment-based presets use zero prices until accurate pricing is supplied through `zpi.providers`; `maxBudgetUsd` requires those prices to enforce a useful monetary budget. Token usage is reported independently of pricing. `rewindFiles` covers SDK Write/Edit checkpoints, not arbitrary shell side effects or external edits. Forks start a new checkpoint history.

## Simple custom tools

```ts
import { defineTool, query } from "@zpi-dev/agent-sdk";
import { Type } from "typebox";

const lookupOrder = defineTool({
  name: "lookup_order",
  description: "Look up an order by ID",
  parameters: Type.Object({ orderId: Type.String() }),
  async execute({ orderId }, { signal }) {
    // orderId is inferred as string; orderService is your application's service.
    return orderService.get(orderId, { signal });
  },
});

for await (const message of query({
  prompt: "Look up order 42",
  options: { model: "deepseek", tools: [lookupOrder.name], zpi: { customTools: [lookupOrder] } },
})) {
  if (message.type === "result" && message.subtype === "success") console.log(message.result);
}
```

`execute(params, { signal, toolCallId })` can return a string or a JSON-serializable object, synchronously or asynchronously. Objects become JSON text; native result `details` is undefined. `label` defaults to `name`. The returned native `ToolDefinition` uses the existing argument validation, permissions, cancellation and error handling through `zpi.customTools`. The public SDK also uses this helper for `Skill`, `TaskOutput`, `TaskStop` and the unsupported `Glob`/`Grep` placeholders. For progress updates, images or custom details, use the original `ToolDefinition` from `@zpi-dev/agent-sdk/host` or the existing plugin interface.

## Deliberately omitted

Only TypeScript is supported. `permissionMode`, sandbox/permission UI, MCP, LSP, plugin UI, marketplaces, remote sessions, account authentication flows, managed enterprise settings, prewarming/CLI transport and other advanced Claude Code services are not implemented. Unsupported top-level options fail explicitly rather than acting as no-ops. Message shapes align for the supported subset; this is not a complete drop-in replacement for every Claude Code capability.

## Native desktop host

`@zpi-dev/agent-sdk/host` exposes the native session creation port for hosts needing indexed storage, background services and plugin assembly. ZPI desktop creates its sessions there, then drives them through `query` with `zpi.session`, `zpi.sessionManager`, `zpi.modelRuntime` and optional prepared `zpi.input`. The host retains ownership and subscriptions. Configure tool/loop policies at session creation for this mode. Ordinary applications should use `query` alone.

## Build and distribution

From the ZPI repository, run `npm run build:sdk`, then `npm pack --workspace @zpi-dev/agent-sdk`. Published output bundles the private ZPI runtime and ships rewritten standalone declaration files; consumers do not need the desktop package or private workspace modules. Local builds are not automatically published to npm.

## Session mirrors and controls

```ts
import { query, InMemorySessionStore, listSessions, listSubagents, getSubagentMessages } from "@zpi-dev/agent-sdk";
const sessionStore = new InMemorySessionStore(); // Replace with your durable adapter.
const options = { cwd: process.cwd(), model: "deepseek", tools: [], sessionStore };
const run = query({ prompt: "Hello", options });
console.log(await run.getContextUsage()); // Reads the engine; does not generate a response.
for await (const message of run) {
  if (message.type === "system" && message.subtype === "mirror_error") console.error(message.error);
}
const sessions = await listSessions({ dir: options.cwd, sessionStore });
if (sessions[0]) {
  const agents = await listSubagents(sessions[0].sessionId, { dir: options.cwd, sessionStore });
  if (agents[0]) console.log(await getSubagentMessages(sessions[0].sessionId, agents[0], { dir: options.cwd, sessionStore }));
}
```

Session helpers also support `deleteSession`, rename, tag and fork on the same `sessionStore`. Main keys use sanitized absolute cwd (or explicit `zpi.projectKey`); subagents use `subagents/agent-{id}`. Adapters preserve opaque JSON entries, deduplicate stable `uuid`, serialize concurrent summary updates, and may use `foldSessionSummary` to maintain `listSessionSummaries`. Missing optional capabilities fail explicitly when required. Deletion/fork require `listSubkeys`; deletion also requires `delete`. Helpers never silently switch from your adapter to the default local directory.

Mirroring follows successful local writes. Append failures retry three times; a 60s timeout does not retry. Final failures emit `mirror_error`, while local persistence errors fail execution. `sessionStoreFlush` is `batched` (default) or `eager`; turn completion and query exit drain writes. Resume loads the adapter first (`loadTimeoutMs`, default 60000), materializes owned temporary files, and falls back to local records only on `null`. Mirrors require persistence and cannot be combined with file checkpointing or host-owned sessions.

`result.usage` measures the current main-loop user turn; `total_cost_usd` and `modelUsage` snapshot session totals, including recorded child costs. Current-query budgets exclude restored historical costs and persist across streaming inputs. Model keys include the provider. Missing historical accounting cannot be reconstructed. `canUseTool` must return allow/deny; `null` produces `SDK_UNSUPPORTED_PERMISSION_NULL` and blocks execution because there is no external approval transport.

Background events are `task_started`, `task_progress`, and one `task_notification` terminal event, linked by task/tool/session IDs. `await run.stopTask(taskId)` shares TaskStop's cancellation and ownership checks. Native hosts can supply `zpi.taskControl`; otherwise this capability reports unsupported. `getContextUsage` distinguishes provider measurements from local estimates. The host entry also exports the complete `TranscriptStore` and `SessionCurrentState` types; `createAgentSession({ storage: { transcript, currentState } })` returns both session and sessionManager. `storage` and sessionManager are mutually exclusive.

Compatibility is pinned to Claude Agent SDK **0.3.319** (2026-11-08), for the supported subset. Native indexed storage and external mirrors are distinct contracts. See the repository's [SDK internals](https://github.com/1316151417/zpi/blob/main/docs/internals/sdk.md) for ownership, restoration and lifecycle details. Version `0.1.62` narrows the permission callback return type: callbacks must return allow/deny; returning null fails closed with `SDK_UNSUPPORTED_PERMISSION_NULL`.
