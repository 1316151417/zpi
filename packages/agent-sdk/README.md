# @zpi-dev/agent-sdk

TypeScript SDK for the ZPI agent runtime. Node.js 24 is required. Its supported API follows the [Claude Agent SDK TypeScript reference](https://code.claude.com/docs/zh-CN/agent-sdk/typescript); it runs ZPI directly and does not require Claude Code or an Anthropic subscription.

```ts
import { query } from "@zpi-dev/agent-sdk";

for await (const message of query({
  prompt: "Explain this project",
  options: {
    model: "deepseek",
    tools: ["Read", "Glob", "Grep"],
    allowedTools: ["Read", "Glob", "Grep"],
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
| Tools | `tools`, `allowedTools`, `disallowedTools`, `canUseTool`; canonical `Read`, `Write`, `Edit`, `Bash`, `Glob`, `Grep`, `Skill`, `Agent`, `TaskOutput`, `TaskStop` |
| Controls | `interrupt`, `close`, `setModel`, `setMaxThinkingTokens`, supported command/model/agent discovery, initialization result |
| Limits | `maxTurns`, `maxBudgetUsd`, `thinking`, `effort`, `maxThinkingTokens`, abort signals |
| Output | Partial streaming, usage/cost/model totals, JSON schema validation with up to three attempts |
| Hooks | TypeScript callbacks for session start/end, prompt submit, pre/post tool, tool failure, stop, subagent start/stop, pre/post compaction |
| Resources | Explicit local plugins: command hooks, prompt commands, skills, Agent markdown definitions. `settingSources` explicitly opts into user/project/local instruction and skill discovery |
| Files | Opt-in `enableFileCheckpointing` and `rewindFiles`, with external edit checks |

`tools` chooses which tools the model sees. `allowedTools` pre-approves matching calls; it does not hide other tools. `disallowedTools` wins over allow rules. A bare deny removes a tool from the model's context; an argument-qualified deny checks calls. Other calls go to `canUseTool`, or execute directly when no callback is configured. This embedded runtime has no interactive permission dialog and is not a sandbox. Configure `tools: []` for text/image chat without local capabilities. `Grep` requires `rg` on PATH. Tool results use canonical parameter names such as `file_path` and `tool_use_id`.

`systemPrompt` replaces the default base instructions. Resources, skill catalogs and plugin context are managed independently as named blocks; changes append replacement or withdrawal notices at their conversation position. The `claude_code` preset selects ZPI's coding assistant prompt, not Anthropic's proprietary prompt. Default `settingSources` is empty. Only explicitly supplied local plugins execute command hooks; adding a plugin authorizes its code in the host process environment. Agent model aliases must resolve to registered models. `forwardSubagentText` defaults to false. Background tasks belong to their parent Query and are cancelled when it closes.

Pricing is provider configuration. Environment-based presets use zero prices until accurate pricing is supplied through `zpi.providers`; `maxBudgetUsd` requires those prices to enforce a useful monetary budget. Token usage is reported independently of pricing. `rewindFiles` covers SDK Write/Edit checkpoints, not arbitrary shell side effects or external edits. Forks start a new checkpoint history.

## Deliberately omitted

Only TypeScript is supported. `permissionMode`, sandbox/permission UI, MCP, LSP, plugin UI, marketplaces, remote sessions, account authentication flows, managed enterprise settings, prewarming/CLI transport and other advanced Claude Code services are not implemented. Unsupported top-level options fail explicitly rather than acting as no-ops. Message shapes align for the supported subset; this is not a complete drop-in replacement for every Claude Code capability.

## Native desktop host

`@zpi-dev/agent-sdk/host` exposes the native session creation port for hosts needing indexed storage, background services and plugin assembly. ZPI desktop creates its sessions there, then drives them through `query` with `zpi.session`, `zpi.sessionManager`, `zpi.modelRuntime` and optional prepared `zpi.input`. The host retains ownership and subscriptions. Configure tool/loop policies at session creation for this mode. Ordinary applications should use `query` alone.

## Build and distribution

From the ZPI repository, run `npm run build:sdk`, then `npm pack --workspace @zpi-dev/agent-sdk`. Published output bundles the private ZPI runtime and ships rewritten standalone declaration files; consumers do not need the desktop package or private workspace modules. Local builds are not automatically published to npm.
