# Tool execution parity

Ordinary batches follow Pi: parallel by default, with an entire batch running
sequentially when any declared tool requests sequential execution. Argument
preparation and before hooks run in declaration order before a parallel batch
starts. Preflight failures bypass after hooks. Tool results enter history in
declaration order. Existing file mutation queues continue to serialize edits to
the same file.

Streaming execution follows ZCode's readOnly coordinator. Only an explicit
toolcall_end admits a call; parsable intermediate JSON is insufficient. Admission
requires readOnly, concurrentSafe, no destructive effect, no approval or user
interaction, and sideEffectScope none. The built-in read tool declares these
properties. A successful model response reuses streamed results exactly once.
Calls and completed results are journaled before execution and drain respectively.
Interrupted sessions restore these tool cards and paired results without rerunning
tools; unresolved calls receive an unknown_execution_state error.

Cancellation and failed-stream recovery abort the per-response controller and
allow 250 ms for in-flight calls to settle. Recovery retains completed results,
creates unknown_execution_state errors for unresolved handles, and creates
not_executed errors for calls that were never launched. It discards partial text
and reasoning, then continues from the paired tool results. Late execution
events cannot modify a recovered response. Existing recovery limits remain.

The core stays limited to read, write, edit, and bash. No subagents, background
orchestration, provider protocol heuristics, thinking or compaction changes.

Validation covers ordered preparation, parallel and sequential execution,
explicit completion, safety admission, result reuse, interruption and recovery,
session persistence, and rendering of tools completed before message_end.
