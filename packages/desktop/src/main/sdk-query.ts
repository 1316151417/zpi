import { type QueryParams, query, type SDKMessage, type SDKResultMessage } from "zpi-agent-sdk";

/** Consume the public SDK protocol while native event subscriptions retain richer desktop projections. */
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
