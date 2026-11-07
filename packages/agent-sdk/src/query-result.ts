import { type QueryParams, query } from "./query.ts";
import type { SDKMessage, SDKResultMessage } from "./types.ts";

/** Consume a query and return its successful terminal result. */
export async function queryResult(
  params: QueryParams,
  observe?: (message: SDKMessage) => void,
): Promise<Extract<SDKResultMessage, { subtype: "success" }>> {
  let result: SDKResultMessage | undefined;
  for await (const message of query(params)) {
    observe?.(message);
    if (message.type === "result") result = message;
  }
  if (!result) throw new Error("Agent SDK returned no result");
  if (result.subtype !== "success")
    throw Object.assign(new Error(result.errors.join("\n")), { sdkResult: result });
  return result;
}

export function nativeStopReason(reason: string | null): string {
  return reason === "end_turn"
    ? "stop"
    : reason === "tool_use"
      ? "toolUse"
      : reason === "max_tokens"
        ? "length"
        : (reason ?? "error");
}
