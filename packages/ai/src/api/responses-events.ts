import type { Response as ModelResponse, ResponseStreamEvent } from "openai/resources/responses/responses";
import { isJsonObject } from "../utils/transcript.ts";

/** Some Responses-compatible gateways ignore stream:true and return a complete JSON response. */
export async function* responsesEvents(
  stream: AsyncIterable<ResponseStreamEvent>,
  response: Response,
): AsyncIterable<ResponseStreamEvent> {
  const mediaType = response.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
  if (mediaType !== "application/json" && !mediaType?.endsWith("+json")) {
    yield* stream;
    return;
  }
  const body: unknown = await response.json();
  if (!isJsonObject(body)) throw new Error("Invalid Responses JSON response");
  if (isJsonObject(body.error))
    throw Object.assign(new Error(`OpenAI Responses: ${String(body.error.message ?? "Request failed")}`), {
      code: body.error.code,
    });
  if (typeof body.id !== "string" || typeof body.model !== "string" || !Array.isArray(body.output))
    throw new Error("Invalid Responses JSON response: expected id, model and output");
  if (body.status !== "completed" && body.status !== "incomplete" && body.status !== "failed")
    throw new Error(`Responses JSON response is not terminal: ${String(body.status)}`);
  yield {
    type: `response.${body.status}`,
    response: body as unknown as ModelResponse,
    sequence_number: 0,
  };
}
