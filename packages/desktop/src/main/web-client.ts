import { isIP } from "node:net";

export interface WebSearchInput {
  query: string;
  count?: number;
  ori_question?: string | null;
  localization?: string;
  need_content?: boolean;
}
export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
  summary: string;
  content: string;
  site_name: string | null;
  site_icon: string | null;
  date: string | null;
  rerank_score: number;
  authority: number;
}
export interface WebFetchResult {
  title: string;
  content: string;
}

export const WEB_DEADLINE_MS = 30_000;
export const WEB_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_ATTEMPTS = 3;
const MAX_RETRY_WAIT_MS = 5_000;
type Operation = "search" | "fetch";
const endpoints = {
  search: "https://api.deepseek.com/v1/tools/search",
  fetch: "https://api.deepseek.com/v1/tools/fetch",
} as const;

export class WebRequestError extends Error {
  truncated: boolean;
  constructor(message: string, truncated = false) {
    super(message);
    this.name = "WebRequestError";
    this.truncated = truncated;
  }
}

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const nullableString = (value: unknown): value is string | null =>
  value === null || typeof value === "string";
const invalidResponse = () =>
  new WebRequestError("DeepSeek returned an invalid web response. Please try again.");

function privateIPv4(host: string) {
  const [a, b, c] = host.split(".").map(Number);
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)) || (b === 88 && c === 99))) ||
    (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
    (a === 203 && b === 0 && c === 113)
  );
}

/** Literal/hostname screening only: DeepSeek owns DNS resolution and upstream redirect policy. */
export function publicWebUrl(value: unknown): string | null {
  if (
    typeof value !== "string" ||
    !value ||
    Array.from(value).length > 8192 ||
    /[\s\\]/u.test(value) ||
    Array.from(value).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) ||
    !/^https?:\/\/[^/?#@]+(?:[/?#]|$)/i.test(value)
  )
    return null;
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || !url.hostname || url.username || url.password)
      return null;
    const host = url.hostname.toLowerCase().replace(/\.+$/, "");
    const literal = host.replace(/^\[|\]$/g, "");
    const version = isIP(literal);
    if (version === 4) return privateIPv4(literal) ? null : value;
    if (version === 6) {
      // Only ordinary global unicast literals; reject mapped, link-local, transition and reserved ranges.
      const [first, second = "0"] = literal.split(":");
      const prefix = Number.parseInt(first, 16);
      const subnet = Number.parseInt(second || "0", 16);
      if (
        !Number.isFinite(prefix) ||
        prefix < 0x2000 ||
        prefix > 0x3fff ||
        prefix === 0x2002 ||
        (prefix === 0x2001 && (subnet < 0x200 || subnet === 0xdb8)) ||
        (prefix === 0x3fff && subnet <= 0xfff)
      )
        return null;
      return value;
    }
    if (
      !host.includes(".") ||
      /(?:^|\.)(?:localhost|local|localdomain|internal|intranet|lan|home|test|invalid|onion)$/.test(host) ||
      host === "home.arpa" ||
      host.endsWith(".home.arpa") ||
      host.split(".").some((label) => !/^[a-z\d](?:[a-z\d-]*[a-z\d])?$/.test(label))
    )
      return null;
    return value;
  } catch {
    return null;
  }
}

function unicodeLength(value: string) {
  return Array.from(value).length;
}

export function searchInput(value: unknown): WebSearchInput {
  const invalid = () =>
    new WebRequestError(
      "Invalid web_search arguments. Use query (1–128 Unicode characters), count (1–50), and the documented optional fields.",
    );
  if (
    !object(value) ||
    Object.keys(value).some(
      (key) => !["query", "count", "ori_question", "localization", "need_content"].includes(key),
    ) ||
    typeof value.query !== "string" ||
    !value.query.trim() ||
    unicodeLength(value.query) > 128 ||
    (value.count !== undefined &&
      (!Number.isInteger(value.count) || (value.count as number) < 1 || (value.count as number) > 50)) ||
    (value.ori_question !== undefined &&
      value.ori_question !== null &&
      (typeof value.ori_question !== "string" ||
        unicodeLength(value.ori_question) < 1 ||
        unicodeLength(value.ori_question) > 128)) ||
    (value.localization !== undefined && typeof value.localization !== "string") ||
    (value.need_content !== undefined && typeof value.need_content !== "boolean")
  )
    throw invalid();
  // Leave omitted optional fields omitted; DeepSeek applies its documented defaults.
  return {
    query: value.query,
    ...(value.count !== undefined ? { count: value.count as number } : {}),
    ...(value.ori_question !== undefined ? { ori_question: value.ori_question as string | null } : {}),
    ...(value.localization !== undefined ? { localization: value.localization as string } : {}),
    ...(value.need_content !== undefined ? { need_content: value.need_content as boolean } : {}),
  };
}

export function fetchInput(value: unknown): { url: string } {
  const url =
    object(value) && Object.keys(value).every((key) => key === "url") ? publicWebUrl(value.url) : null;
  if (!url)
    throw new WebRequestError(
      "Invalid web_fetch URL. Use a public HTTP or HTTPS URL without credentials (maximum 8192 characters).",
    );
  return { url };
}

export function searchResponse(value: unknown): WebSearchResult[] {
  if (!object(value) || !Array.isArray(value.results) || value.results.length > 50) throw invalidResponse();
  return value.results.map((item) => {
    if (
      !object(item) ||
      ![item.title, item.url, item.snippet, item.summary, item.content].every(
        (field) => typeof field === "string",
      ) ||
      !nullableString(item.site_name) ||
      !nullableString(item.site_icon) ||
      !nullableString(item.date) ||
      (item.date !== null &&
        (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(item.date) ||
          !Number.isFinite(Date.parse(item.date)))) ||
      typeof item.rerank_score !== "number" ||
      !Number.isFinite(item.rerank_score) ||
      item.rerank_score < 0 ||
      item.rerank_score > 3 ||
      typeof item.authority !== "number" ||
      !Number.isInteger(item.authority) ||
      item.authority < -1 ||
      item.authority > 4
    )
      throw invalidResponse();
    const url = publicWebUrl(item.url);
    if (!url) throw invalidResponse();
    return {
      title: item.title as string,
      url,
      snippet: item.snippet as string,
      summary: item.summary as string,
      content: item.content as string,
      site_name: item.site_name,
      site_icon: publicWebUrl(item.site_icon),
      date: item.date,
      rerank_score: item.rerank_score,
      authority: item.authority,
    };
  });
}

export function fetchResponse(value: unknown): WebFetchResult {
  if (!object(value) || typeof value.title !== "string" || typeof value.content !== "string")
    throw invalidResponse();
  if (!value.content.trim())
    throw new WebRequestError("DeepSeek returned no usable page content. Try another source.");
  return { title: value.title, content: value.content };
}

function aborted() {
  return new WebRequestError("Web request cancelled.");
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal, late?: (value: T) => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let cancelled = signal.aborted;
    const abort = () => {
      cancelled = true;
      reject(aborted());
    };
    if (cancelled) reject(aborted());
    else signal.addEventListener("abort", abort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        if (cancelled) late?.(value);
        else resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(aborted());
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(aborted());
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, ms);
    signal.addEventListener("abort", abort, { once: true });
  });
}

// Share pacing across this instance's sessions and keys; other clients may still trigger account-level 429.
const limits = {
  search: { nextAt: 0, tail: Promise.resolve() },
  fetch: { nextAt: 0, tail: Promise.resolve() },
};
function throttle(operation: Operation, signal: AbortSignal) {
  const state = limits[operation];
  const turn = state.tail.then(async () => {
    if (signal.aborted) throw aborted();
    await wait(Math.max(0, state.nextAt - Date.now()), signal);
    if (signal.aborted) throw aborted();
    state.nextAt = Date.now() + 200;
  });
  state.tail = turn.catch(() => {});
  return abortable(turn, signal);
}

function discard(response: Response) {
  void response.body?.cancel().catch(() => {});
}

async function readJson(response: Response, signal: AbortSignal): Promise<unknown> {
  const oversized = () =>
    new WebRequestError(
      "DeepSeek's response exceeded the 2 MiB limit. Try a narrower query or another page.",
      true,
    );
  if (Number(response.headers.get("content-length")) > WEB_RESPONSE_BYTES) {
    discard(response);
    throw oversized();
  }
  if (!response.body) throw invalidResponse();
  const reader = response.body.getReader();
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener("abort", cancel, { once: true });
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  try {
    while (true) {
      if (signal.aborted) throw aborted();
      const chunk = await abortable(reader.read(), signal);
      if (signal.aborted) throw aborted();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > WEB_RESPONSE_BYTES) throw oversized();
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
    try {
      return JSON.parse(text);
    } catch {
      throw invalidResponse();
    }
  } finally {
    signal.removeEventListener("abort", cancel);
    cancel();
  }
}

function retryWait(response: Response, attempt: number) {
  const header = response.headers.get("retry-after")?.trim();
  if (header && /^\d+(?:\.\d+)?$/.test(header)) {
    const milliseconds = Number(header) * 1_000;
    // A syntactically valid, enormous wait must not wrap a timer or fall back to an earlier retry.
    return Number.isFinite(milliseconds) ? milliseconds : Number.POSITIVE_INFINITY;
  }
  const date = header ? Date.parse(header) - Date.now() : NaN;
  return Number.isFinite(date) ? Math.max(0, date) : Math.min(MAX_RETRY_WAIT_MS, 500 * 2 ** attempt);
}

function statusError(status: number) {
  const messages: Record<number, string> = {
    400: "DeepSeek rejected the web request. Check the tool arguments.",
    401: "DeepSeek authentication failed. Check the Web Tools API key in Settings.",
    402: "DeepSeek account balance is insufficient. Add credit before retrying.",
    403: "DeepSeek's security policy refused this page.",
    404: "DeepSeek could not retrieve usable page content. Try another source.",
    408: "DeepSeek timed out after limited retries. Please try again later.",
    413: "DeepSeek rejected the request because it was too large.",
    429: "DeepSeek's request limit was reached after limited retries. Please try again later.",
  };
  return new WebRequestError(
    messages[status] ??
      (status >= 500
        ? "DeepSeek is temporarily unavailable after limited retries. Please try again later."
        : "DeepSeek returned an unexpected web response."),
  );
}

export async function requestWeb(
  operation: Operation,
  input: WebSearchInput | { url: string },
  key: string,
  requestFetch: typeof fetch,
  signal: AbortSignal,
  beforeRequest?: () => void,
): Promise<unknown> {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    await throttle(operation, signal);
    if (signal.aborted) throw aborted();
    beforeRequest?.();
    const response = await abortable(
      requestFetch(endpoints[operation], {
        method: "POST",
        redirect: "error",
        credentials: "omit",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(input),
        signal,
      }),
      signal,
      discard,
    );
    if (signal.aborted) {
      discard(response);
      throw aborted();
    }
    if (response.redirected || (response.status >= 300 && response.status < 400)) {
      discard(response);
      throw new WebRequestError("DeepSeek returned an unexpected redirect. The request was stopped.");
    }
    if (response.status === 200) return readJson(response, signal);
    discard(response);
    const retry = response.status === 408 || response.status === 429 || response.status >= 500;
    if (!retry || attempt + 1 === MAX_ATTEMPTS) throw statusError(response.status);
    const delay = retryWait(response, attempt);
    if (delay >= WEB_DEADLINE_MS)
      throw new WebRequestError(
        "DeepSeek requested a retry wait beyond this tool’s deadline. Please try again later.",
      );
    await wait(delay, signal);
  }
  throw new WebRequestError("DeepSeek web request failed.");
}
