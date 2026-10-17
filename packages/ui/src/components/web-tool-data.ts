import type { WebSearchSource, WebToolDetails } from "../types.ts";

export const webToolLimits = {
  content: 64 * 1024,
  results: 50,
  query: 2000,
  url: 8192,
  title: 512,
  snippet: 4000,
  summary: 4000,
  message: 2000,
} as const;

/** Never route service-controlled destinations through the local-file link resolver. */
export function safeWebUrl(value: unknown): string | undefined {
  if (
    typeof value !== "string" ||
    Array.from(value).length > webToolLimits.url ||
    Array.from(value).some(
      (character) => character.charCodeAt(0) <= 32 || character === "\u007f" || character === "\\",
    ) ||
    !/^https?:\/\//i.test(value)
  )
    return undefined;
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || !url.hostname || url.username || url.password)
      return undefined;
    return value;
  } catch {
    return undefined;
  }
}

const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

/** Copy only the bounded, typed data that the UI understands, including restored history. */
export function normalizeWebToolDetails(value: unknown, toolName?: string): WebToolDetails | undefined {
  if (
    !record(value) ||
    (value.kind !== "web_search" && value.kind !== "web_fetch") ||
    (toolName !== undefined && value.kind !== toolName) ||
    typeof value.status !== "string" ||
    !["pending", "success", "error", "cancelled"].includes(value.status)
  )
    return undefined;
  let truncated = value.truncated === true;
  const text = (input: unknown, limit: number): string | undefined => {
    if (typeof input !== "string") return undefined;
    if (input.length > limit) truncated = true;
    return input.slice(0, limit);
  };
  const result: WebToolDetails = {
    kind: value.kind,
    status: value.status as WebToolDetails["status"],
  };
  for (const key of ["query", "title", "content", "message"] as const) {
    const field = text(value[key], webToolLimits[key]);
    if (field !== undefined) result[key] = field;
  }
  const url = safeWebUrl(value.url);
  if (url) result.url = url;
  if (Array.isArray(value.results)) {
    if (value.results.length > webToolLimits.results) truncated = true;
    const sources: WebSearchSource[] = [];
    for (const source of value.results.slice(0, webToolLimits.results)) {
      if (!record(source)) continue;
      const url = safeWebUrl(source.url);
      const title = text(source.title, webToolLimits.title);
      const snippet = text(source.snippet, webToolLimits.snippet);
      if (!url || title === undefined || snippet === undefined) continue;
      const summary = text(source.summary, webToolLimits.summary);
      sources.push({
        url,
        title,
        snippet,
        ...(summary !== undefined ? { summary } : {}),
        site_name: text(source.site_name, 256) ?? null,
        site_icon: safeWebUrl(source.site_icon) ?? null,
        date: text(source.date, 128) ?? null,
      });
    }
    result.results = sources;
  }
  if (truncated) result.truncated = true;
  return result;
}

/** SDK preflight cancellations happen before the web tool can emit structured details. */
export function cancelledWebTool(
  name: string,
  output: string,
  isError?: boolean,
): WebToolDetails | undefined {
  if (
    (name === "web_search" || name === "web_fetch") &&
    isError &&
    /^Tool cancelled before execution(?:; effects unknown)?$/.test(output)
  )
    return { kind: name, status: "cancelled", message: "联网工具已取消。" };
  return undefined;
}
