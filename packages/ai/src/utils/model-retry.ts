// Structured error details adapted from ZCode failure-classifier.ts (Apache-2.0).
// Retry decisions use Pi utils/retry.ts. See THIRD_PARTY_NOTICES.md.
import type { ModelFailure } from "../types.ts";

const TERMINAL_CODES = new Set([
  "1005",
  "1006",
  "1008",
  "1113",
  "1261",
  "1304",
  "1308",
  "1309",
  "1310",
  "1311",
  "1313",
  "1314",
  "1315",
  "1316",
  "1317",
  "1318",
  "1319",
  "1320",
  "1321",
  "20097",
  "2056",
  "3001",
  "3006",
  "3007",
  "3008",
  "3009",
  "3010",
  "insufficient_quota",
  "credit_balance_exhausted",
  "organization_spend_limit_exceeded",
  "project_spend_limit_exceeded",
  "organization_usage_limit_exceeded",
  "exceeded_current_quota_error",
]);
const TRANSIENT_CODES = new Set([
  "500",
  "1120",
  "1230",
  "1234",
  "1302",
  "1303",
  "1305",
  "1312",
  "2007",
  "3002",
  "rate_limit_reached_error",
  "rate_limit_error",
  "engine_overloaded_error",
  "overloaded_error",
  "network_error",
  "network_error_retryable",
  "ECONNRESET",
  "ECONNREFUSED",
  "EAI_AGAIN",
  "ENOTFOUND",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "UND_ERR_SOCKET",
  "ETIMEDOUT",
  "ETIMEOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
]);

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

/** Preserve retry facts before provider errors are converted into transcript text. */
export function modelFailure(error: unknown, signal?: AbortSignal): ModelFailure {
  const seen = new Set<unknown>();
  const records: Record<string, unknown>[] = [];
  for (let current = error; current && !seen.has(current); current = record(current).cause) {
    seen.add(current);
    records.push(record(current));
  }
  const status = records.map((r) => r.status ?? r.statusCode).find((v) => typeof v === "number") as
    | number
    | undefined;
  const headersValue = records.map((r) => r.headers ?? r.responseHeaders).find((v) => v != null);
  const headers =
    headersValue instanceof Headers
      ? headersValue
      : new Headers(
          Object.entries(record(headersValue)).filter(
            (entry): entry is [string, string] => typeof entry[1] === "string",
          ),
        );
  const shouldRetry = headers.get("x-should-retry")?.trim().toLowerCase();
  let retryAfterMs: number | undefined;
  if (shouldRetry !== "false" && shouldRetry !== "0") {
    const ms = headers.get("retry-after-ms");
    const after = headers.get("retry-after");
    if (ms?.trim() && Number.isFinite(Number(ms))) retryAfterMs = Math.max(0, Math.round(Number(ms)));
    else if (after?.trim()) {
      const delay = Number.isFinite(Number(after)) ? Number(after) * 1000 : Date.parse(after) - Date.now();
      if (Number.isFinite(delay)) retryAfterMs = Math.max(0, Math.round(delay));
    }
  }
  const codes = records.flatMap((r) => {
    const body = record(r.error);
    return [r.code, body.code, body.type].flatMap((v) =>
      typeof v === "string" || typeof v === "number" ? [String(v)] : [],
    );
  });
  const aborted = signal?.aborted || records.some((r) => r.name === "AbortError" || r.code === "ABORT_ERR");
  const terminal = codes.some((code) => TERMINAL_CODES.has(code) || /CERT|TLS|SSL/iu.test(code));
  const retryable =
    !aborted &&
    !terminal &&
    (codes.some((code) => TRANSIENT_CODES.has(code) || code.toUpperCase().includes("PROXY")) ||
      status === 408 ||
      status === 429 ||
      (status !== undefined && status >= 500) ||
      records.some(
        (r) =>
          r.isRetryable === true ||
          r.name === "APIConnectionError" ||
          r.name === "APIConnectionTimeoutError" ||
          r.name === "TimeoutError" ||
          r.name === "timeout_error" ||
          (record(r.error).type === "api_error" &&
            ["500 internal network error", "internal network error", "internal network failure"].includes(
              String(record(r.error).message ?? r.message ?? "")
                .trim()
                .toLowerCase(),
            )) ||
          (typeof r.message === "string" && /^Stream ended without /u.test(r.message)),
      ) ||
      (status === 409 && shouldRetry !== "false") ||
      (status === undefined && shouldRetry === "true"));
  return {
    retryable,
    ...(status !== undefined ? { status } : {}),
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
  };
}
