import { assertSupportedOptions } from "@zpi-dev/ai";
import { validateId, validateKey, validateStore } from "./session-store.ts";
import type { Options } from "./types.ts";

export const zpiOptionKeys = [
  "requestOptions",
  "modelRuntime",
  "providers",
  "fetch",
  "agentDir",
  "plugins",
  "customTools",
  "resourceLoader",
  "session",
  "sessionManager",
  "input",
  "taskControl",
  "projectKey",
] as const;

const hookEvents = new Set([
  "SessionStart",
  "SessionEnd",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "Stop",
  "SubagentStart",
  "SubagentStop",
  "PreCompact",
  "PostCompact",
]);
export function validateOptions(options: Options): void {
  if (options.zpi) assertSupportedOptions(options.zpi, zpiOptionKeys, "zpi");
  if (
    !options.zpi?.session &&
    (options.zpi?.sessionManager || options.zpi?.input || options.zpi?.taskControl)
  )
    throw new Error("Host sessionManager, input and taskControl require zpi.session");
  for (const name of [
    "persistSession",
    "continue",
    "forkSession",
    "includePartialMessages",
    "forwardSubagentText",
    "includeHookEvents",
    "enableFileCheckpointing",
  ] as const)
    if (options[name] !== undefined && typeof options[name] !== "boolean") throw new Error(`Invalid ${name}`);
  if (
    options.settingSources !== undefined &&
    (!Array.isArray(options.settingSources) ||
      options.settingSources.some((source) => !["user", "project", "local"].includes(source)))
  )
    throw new Error("Invalid settingSources");
  if (
    options.systemPrompt !== undefined &&
    typeof options.systemPrompt !== "string" &&
    !Array.isArray(options.systemPrompt)
  ) {
    const prompt = options.systemPrompt;
    assertSupportedOptions(
      prompt,
      prompt.type === "custom" ? ["type", "prompt"] : ["type", "preset", "append"],
      "systemPrompt",
    );
    if (prompt.type !== "custom" && (prompt.type !== "preset" || prompt.preset !== "claude_code"))
      throw new Error("Invalid systemPrompt preset");
  }
  for (const id of [options.resume, options.sessionId]) if (id !== undefined) validateId(id);
  if (options.zpi?.projectKey !== undefined)
    validateKey({ projectKey: options.zpi.projectKey, sessionId: "validate" });
  if (options.resume && options.continue) throw new Error("Use resume or continue, not both");
  if (options.sessionId && (options.resume || options.continue))
    throw new Error("sessionId cannot be combined with resume or continue");
  if (options.resumeSessionAt && !options.resume && !options.continue)
    throw new Error("resumeSessionAt requires resume or continue");
  if (options.sessionStore !== undefined) {
    validateStore(options.sessionStore);
    if (options.persistSession === false)
      throw new Error("sessionStore cannot be used with persistSession: false");
    if (options.zpi?.session || options.zpi?.sessionManager)
      throw new Error("sessionStore cannot be used with a host-owned session");
    if (options.enableFileCheckpointing)
      throw new Error("enableFileCheckpointing is not supported with sessionStore");
    if (options.continue && !options.sessionStore.listSessions)
      throw new Error("continue with sessionStore requires listSessions");
    if (options.resumeSessionAt && !options.forkSession)
      throw new Error("resumeSessionAt with sessionStore requires forkSession");
  }
  if (options.sessionStoreFlush !== undefined && !["batched", "eager"].includes(options.sessionStoreFlush))
    throw new Error("Invalid sessionStoreFlush");
  if (
    options.loadTimeoutMs !== undefined &&
    (!Number.isSafeInteger(options.loadTimeoutMs) || options.loadTimeoutMs <= 0)
  )
    throw new Error("Invalid loadTimeoutMs");
  for (const key of ["tools", "allowedTools", "disallowedTools"] as const) {
    const value = options[key];
    if (key === "tools" && value && !Array.isArray(value)) {
      assertSupportedOptions(value, ["type", "preset"], "tools");
      if (value.type !== "preset" || value.preset !== "claude_code") throw new Error("Invalid tools preset");
    } else if (
      value !== undefined &&
      (!Array.isArray(value) || value.some((name) => typeof name !== "string" || !name))
    )
      throw new Error(`Invalid ${key}`);
  }
  if (options.thinking) {
    assertSupportedOptions(options.thinking, ["type", "budgetTokens"], "thinking");
    if (!["disabled", "adaptive", "enabled"].includes(options.thinking.type))
      throw new Error("Invalid thinking type");
    if (
      "budgetTokens" in options.thinking &&
      (options.thinking.type !== "enabled" ||
        (options.thinking.budgetTokens !== undefined &&
          (!Number.isSafeInteger(options.thinking.budgetTokens) || options.thinking.budgetTokens < 0)))
    )
      throw new Error("Invalid thinking budgetTokens");
  }
  if (options.effort && !["low", "medium", "high", "xhigh", "max"].includes(options.effort))
    throw new Error("Invalid effort");
  if (
    options.maxThinkingTokens !== undefined &&
    (!Number.isSafeInteger(options.maxThinkingTokens) || options.maxThinkingTokens < 0)
  )
    throw new Error("Invalid maxThinkingTokens");
  if (options.outputFormat) {
    assertSupportedOptions(options.outputFormat, ["type", "schema"], "outputFormat");
    if (
      options.outputFormat.type !== "json_schema" ||
      !options.outputFormat.schema ||
      typeof options.outputFormat.schema !== "object" ||
      Array.isArray(options.outputFormat.schema)
    )
      throw new Error("Invalid outputFormat");
  }
  for (const [event, groups] of Object.entries(options.hooks ?? {})) {
    if (!hookEvents.has(event) || !Array.isArray(groups)) throw new Error(`Unsupported hook event: ${event}`);
    for (const group of groups) {
      assertSupportedOptions(group, ["matcher", "hooks", "timeout", "onFailure"], "hook matcher");
      if (!Array.isArray(group.hooks) || group.hooks.some((hook) => typeof hook !== "function"))
        throw new Error("Invalid hook callbacks");
      if (group.matcher !== undefined) new RegExp(group.matcher);
      if (group.timeout !== undefined && (!Number.isFinite(group.timeout) || group.timeout <= 0))
        throw new Error("Invalid hook timeout");
      if (group.onFailure !== undefined && !["continue", "block"].includes(group.onFailure))
        throw new Error("Invalid hook onFailure");
    }
  }
  for (const agent of Object.values(options.agents ?? {})) {
    assertSupportedOptions(
      agent,
      ["description", "prompt", "tools", "disallowedTools", "model", "maxTurns", "effort", "skills"],
      "agent definition",
    );
    if (typeof agent.prompt !== "string" || typeof agent.description !== "string")
      throw new Error("Invalid agent definition");
    if (agent.maxTurns !== undefined && (!Number.isSafeInteger(agent.maxTurns) || agent.maxTurns <= 0))
      throw new Error("Invalid agent maxTurns");
  }
  if (options.zpi?.taskControl) {
    if (
      typeof options.zpi.taskControl.stopTask !== "function" ||
      (options.zpi.taskControl.subscribe !== undefined &&
        typeof options.zpi.taskControl.subscribe !== "function")
    )
      throw new Error("Invalid taskControl");
  }
}
