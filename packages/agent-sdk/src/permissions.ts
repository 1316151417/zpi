import { isAbsolute, resolve } from "node:path";
import { assertSupportedOptions } from "@zpi-dev/ai";
import type { HookRegistration } from "@zpi-dev/coding-agent";
import type { Options, SDKPermissionDenial } from "./types.ts";

interface Rule {
  name: string;
  argument?: string;
}
export function permissionRules(rules: readonly string[] = []): Rule[] {
  return rules.map((source) => {
    const match = /^([A-Za-z0-9_*.-]+)(?:\((.+)\))?$/.exec(source);
    if (!match) throw new Error(`Invalid tool permission rule: ${source}`);
    return { name: match[1], argument: match[2] };
  });
}
function glob(text: string, pattern: string): boolean {
  return new RegExp(
    `^${pattern
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replaceAll("*", ".*")
      .replaceAll("?", ".")}$`,
  ).test(text);
}
export function matchesRule(rule: Rule, name: string, input: Record<string, unknown>, cwd: string): boolean {
  if (!glob(name, rule.name)) return false;
  if (rule.argument === undefined) return true;
  if (typeof input.command === "string") {
    if (rule.argument.endsWith(":*")) {
      const prefix = rule.argument.slice(0, -2);
      return input.command === prefix || input.command.startsWith(`${prefix} `);
    }
    return glob(input.command, rule.argument);
  }
  if (typeof input.file_path === "string") {
    const pattern = isAbsolute(rule.argument) ? rule.argument : resolve(cwd, rule.argument);
    return glob(resolve(cwd, input.file_path), pattern);
  }
  return false;
}
export function permissionHook(
  options: Options,
  denials: SDKPermissionDenial[],
  interrupt: () => void,
  fail?: (error: Error) => void,
): HookRegistration {
  const allow = permissionRules(options.allowedTools),
    deny = permissionRules(options.disallowedTools);
  return {
    event: "PreToolUse",
    onError: "block",
    handler: async (event, signal) => {
      if (!("toolName" in event)) return;
      const input = event.toolInput as Record<string, unknown>;
      const denied = deny.some((rule) => matchesRule(rule, event.toolName, input, event.cwd));
      const allowed = allow.some((rule) => matchesRule(rule, event.toolName, input, event.cwd));
      try {
        const result = denied
          ? { behavior: "deny" as const, message: "Tool use denied by disallowedTools" }
          : allowed || !options.canUseTool
            ? { behavior: "allow" as const }
            : await options.canUseTool(event.toolName, structuredClone(input), {
                signal,
                toolUseID: event.toolCallId,
                requestId: event.invocationId,
              });
        signal.throwIfAborted();
        if (result === null)
          throw new Error("SDK_UNSUPPORTED_PERMISSION_NULL: external approval transport is not supported");
        if (!result || typeof result !== "object" || !["allow", "deny"].includes(result.behavior))
          throw new Error("SDK_INVALID_PERMISSION_RESULT: canUseTool must return allow or deny");
        assertSupportedOptions(
          result,
          result.behavior === "allow" ? ["behavior", "updatedInput"] : ["behavior", "message", "interrupt"],
          "canUseTool result",
        );
        if (
          result.behavior === "allow" &&
          result.updatedInput !== undefined &&
          (!result.updatedInput ||
            typeof result.updatedInput !== "object" ||
            Array.isArray(result.updatedInput))
        )
          throw new Error("SDK_INVALID_PERMISSION_RESULT: updatedInput must be an object");
        if (
          result.behavior === "deny" &&
          (typeof result.message !== "string" ||
            (result.interrupt !== undefined && typeof result.interrupt !== "boolean"))
        )
          throw new Error("SDK_INVALID_PERMISSION_RESULT: invalid denial");
        if (result.behavior === "allow")
          return { ...(result.updatedInput ? { updatedInput: result.updatedInput } : {}) };
        denials.push({
          tool_name: event.toolName,
          tool_use_id: event.toolCallId,
          tool_input: structuredClone(input),
        });
        if (result.interrupt) interrupt();
        return { block: true, reason: result.message || "Tool use was not approved" };
      } catch (error) {
        if (!signal.aborted) fail?.(error instanceof Error ? error : new Error(String(error)));
        throw error;
      }
    },
  };
}
