# Pi core parity

Reference: `/Users/jiezhou/VSCodeProjects/pi`, commit
`cd34e17ff039502f3664d8363b3c0a23f93a2ca3`.

This change ports Pi's compaction algorithm/prompts and assistant retry/overflow
helpers, and aligns default reasoning, history projection and timeout settings.
The four built-in tools and existing parallel/streamed-read execution remain.

## Compaction

- Enabled by default. Reserve 16,384 tokens and retain approximately 20,000 tokens.
  Trigger strictly above `contextWindow - reserveTokens`.
- Check before adding a new user prompt, between successful tool turns before the
  next assistant request, and after an assistant run. Threshold compaction may
  repeat within one user task; it has no once-per-task latch.
- Use provider total usage (including output/cache), then estimate trailing
  messages at four characters per token, with 1,200 tokens per image. Ignore stale
  usage/error messages preceding the latest checkpoint. No global usage-ratio
  calibration remains.
- Manual and automatic compaction use the same cut algorithm. Keep assistant tool
  calls with their results and include adjacent metadata. A turn may be split;
  small conversations below the retention budget may have nothing to summarize.
- Port Pi's initial/update/prefix prompts and text serialization. Tool results in
  summary input are clipped at 2,000 characters. History summaries use 80% of the
  reserve; split-turn prefixes use 50%, both capped by the model output limit.
- Carry forward previous summaries and summarized file operations. Inherit the
  selected reasoning level, use fresh summary routing and disable prompt caching.
  Persist tokens-before, file lists, combined summary usage and ZPI prompt state.
- Context errors, silent input overflow and recoverable length stops share one
  consecutive compact-and-retry attempt. A successful response exceeding the
  input limit is compacted without replaying its answer. A new user prompt or
  successful non-length assistant response resets the recovery budget.
- Failed compaction leaves the stored conversation intact. Aborting a summary
  prevents a new checkpoint. Summary generation uses the same retry settings.

## Default reasoning and history

Explicit reasoning wins. Existing conversations restore their recorded level,
otherwise use the global default. New conversations prefer the per-model setting,
then the global default, then `medium`. Clamp unsupported standard levels upward,
then downward; unsupported custom labels fall back to the first available choice.
Non-reasoning models use `off`. Explicit model defaults used by ZPI's desktop
selection remain compatible with its model configuration.

History getters return fresh arrays sharing append-only records, as Pi does.
Active context projects the latest checkpoint, its kept suffix and subsequent
messages; it does not clone discarded message payloads or replay every checkpoint.
ZPI stores a system-message snapshot because prompt/tool declarations are messages
in its transcript. Legacy checkpoints and removed goal entries remain readable.
Fork/rewind still clone at the mutation boundary and rekey checkpoint references.

## Retry and timeout settings

Read `agentDir/settings.json` (normally `~/.ZPI/agent/settings.json`) and
`cwd/.ZPI/settings.json`, recursively merging project values over global values.
SDK callers may supply `SettingsManager.inMemory(...)` and existing `compaction`
options. Model budgets resolve each field through `compaction.modelOverrides`
keyed by `provider/modelId`, ordinary values, then defaults. Zero is valid;
negative/non-integral token budgets are rejected.

| Setting | Default |
| --- | --- |
| `retry.enabled` | `true` |
| `retry.maxRetries` | `3` agent retries |
| `retry.baseDelayMs` | `2000`; deterministic 2/4/8-second waits |
| `retry.maxAgentDelayMs` | `60000` per agent wait |
| `retry.provider.maxRetries` | unspecified; OpenAI SDK default `2` |
| `retry.provider.timeoutMs` | stream option, provider value, then HTTP idle default |
| `retry.provider.maxRetryDelayMs` | `60000`; `0` disables server-delay cap |
| `httpIdleTimeoutMs` | `300000`; `0`/`"disabled"` disables idle timeout |

Provider retries wrap request establishment only, using Pi's abortable SDK retry
policy and Retry-After cap. Agent retries restart failed assistant turns, including
mid-stream transport failures, using Pi's text classifier and bounded exponential
backoff. Quota/billing errors are excluded from agent retry. Failed assistant
records remain in durable history but are removed from live retry context.
Empty successful responses are not retried. The old ten-retry ZCode stream loop
and jitter policy are removed.

Existing streamed-tool recovery still drains closed reads once and pairs deferred
mutations with interruption results. It now shares the three-retry agent budget
and Pi classifier. Desktop retry presentation starts with the first agent retry;
terminal error presentation waits until the task settles.

Pi configures Undici's dispatcher. ZPI retains Electron `net.fetch` and applies a
scoped header/body idle wrapper with the same defaults and cancellation semantics;
it does not replace Electron's proxy/transport stack. SDK request timeout precedence
matches Pi, using max-int32 when HTTP idle timeout is disabled. This is a platform
adapter, not a byte-identical transport implementation.

## Validation

- `npm run check`: passed; four existing `noImportantStyles` warnings in unchanged
  `packages/ui/src/styles.css`.
- `npm run test:unit`: 76 files, 390 tests passed.
- `npm run build`: passed; existing dependency bundler warnings remain.
- Focused Playwright: six tests passed across automatic/manual compaction,
  compaction cancellation/failure/reload, context usage reset and provider/agent
  reconnect/recovery/backoff cancellation/quota/exhaustion.
- Expanded Playwright runs still fail two mouse-leave assertions in the unchanged
  context tooltip and stop-button tooltip interactions. Their tooltip behavior was
  not modified by this core change.
