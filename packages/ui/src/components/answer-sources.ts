import { decodeString } from "micromark-util-decode-string";
import type { WebOpenOptions } from "../link-target.ts";
import type { RunView } from "../types.ts";
import { safeWebUrl } from "./web-tool-data.ts";

export interface AnswerSource {
  url: string;
  hostname: string;
  title: string;
  siteName: string;
  siteIcon?: string;
  date?: string;
  excerpt?: string;
}

export const answerSourceLimits = {
  icons: 5,
  title: 256,
  siteName: 128,
  date: 64,
  excerpt: 280,
  fetchPrefix: 4096,
  iconConcurrency: 4,
  iconCache: 128,
  iconFailureTtl: 60_000,
  iconData: 128 * 1024,
} as const;

function shortText(value: unknown, limit: number): string | undefined {
  if (typeof value !== "string") return undefined;
  // Bound work as well as output, even for an unexpectedly large restored field.
  const text = decodeString(value.slice(0, limit * 8))
    .replace(/\s+/gu, " ")
    .trim();
  if (!text) return undefined;
  const characters = Array.from(text);
  return characters.length > limit ? `${characters.slice(0, limit - 1).join("")}…` : text;
}

function fetchExcerpt(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  // Fetch has no snippet field. Derive a short plain-text preview from a bounded
  // prefix, never run a Markdown/HTML renderer or retain the fetched page body.
  const text = value
    .slice(0, answerSourceLimits.fetchPrefix)
    .replace(/\r\n?/gu, "\n")
    .replace(/<!--[\s\S]*?(?:-->|$)/gu, " ")
    .replace(/<(script|style)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/giu, " ")
    .replace(/```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)/gu, " ")
    .replace(/^[ \t]{0,3}\[[^\]]+\]:[^\n]*/gmu, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/gu, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, "$1")
    .replace(/!?\[([^\]]*)\]\s*\[[^\]]*\]/gu, "$1")
    .replace(/<[^>]*>/gu, " ")
    .replace(/\bhttps?:\/\/[^\s<>()]+/gu, " ")
    .replace(/^[ \t]*(?:#{1,6}\s+|>\s*|[-+*]\s+|\d+[.)]\s+)/gmu, "")
    .replace(/[*~`]|(?<![\p{L}\p{N}])_+|_+(?![\p{L}\p{N}])/gu, "");
  return shortText(text.replace(/\s+([,.;:!?，。；：！？])/gu, "$1"), answerSourceLimits.excerpt);
}

/** Project this answer's preceding tool metadata only; never parse model output. */
export function collectAnswerSources(run: RunView, answerBlockId?: string): AnswerSource[] {
  const answerIndex = run.orderedBlocks.findIndex((block) => block.id === answerBlockId);
  const answer = run.orderedBlocks[answerIndex];
  if (answer?.type !== "text" || !answer.text.trim()) return [];
  // Text and tools in the same assistant message cannot use one another's results.
  // An explicit answer boundary also prevents later tools enriching earlier prose.
  const messageStart = run.orderedBlocks.findIndex((block) => block.messageId === answer.messageId);
  const boundary = Math.min(answerIndex, messageStart);
  type Entry = Omit<AnswerSource, "title" | "siteName" | "excerpt"> & {
    title?: string;
    siteName?: string;
    snippet?: string;
    summary?: string;
    fetchExcerpt?: string;
  };
  const entries = new Map<string, Entry>();
  const add = (value: {
    url?: unknown;
    title?: unknown;
    snippet?: unknown;
    summary?: unknown;
    site_name?: unknown;
    site_icon?: unknown;
    date?: unknown;
    fetchExcerpt?: string;
  }) => {
    const url = safeWebUrl(value.url);
    if (!url) return;
    const entry = entries.get(url) ?? { url, hostname: new URL(url).hostname };
    entry.title ||= shortText(value.title, answerSourceLimits.title);
    entry.siteName ||= shortText(value.site_name, answerSourceLimits.siteName);
    entry.siteIcon ||= safeWebUrl(value.site_icon);
    entry.date ||= shortText(value.date, answerSourceLimits.date);
    entry.snippet ||= shortText(value.snippet, answerSourceLimits.excerpt);
    entry.summary ||= shortText(value.summary, answerSourceLimits.excerpt);
    entry.fetchExcerpt ||= value.fetchExcerpt;
    entries.set(url, entry);
  };
  for (let index = 0; index < boundary; index++) {
    const block = run.orderedBlocks[index];
    if (
      block.type !== "tool" ||
      block.status !== "completed" ||
      block.isError ||
      !block.web ||
      block.web.status !== "success" ||
      block.web.kind !== block.name
    )
      continue;
    if (block.web.kind === "web_search" && Array.isArray(block.web.results)) {
      for (const source of block.web.results) {
        if (source && typeof source === "object") add(source);
      }
    } else if (block.web.kind === "web_fetch") {
      add({ url: block.web.url, title: block.web.title, fetchExcerpt: fetchExcerpt(block.web.content) });
    }
  }
  return [...entries.values()].map(({ snippet, summary, fetchExcerpt, ...entry }) => ({
    ...entry,
    title: entry.title ?? shortText(entry.url, answerSourceLimits.title) ?? entry.hostname,
    siteName: entry.siteName ?? entry.hostname,
    excerpt: snippet ?? summary ?? fetchExcerpt,
  }));
}

/** Keep hostname order, allowing a later page on that site to provide its icon. */
export function answerSourceSites(sources: AnswerSource[]): AnswerSource[] {
  const sites = new Map<string, AnswerSource>();
  for (const source of sources) {
    const previous = sites.get(source.hostname);
    if (previous) {
      if (!previous.siteIcon && source.siteIcon) sites.set(source.hostname, source);
    } else if (sites.size < answerSourceLimits.icons) sites.set(source.hostname, source);
  }
  return [...sites.values()];
}

export function openAnswerSource(
  url: unknown,
  onLink: (url: string, options?: WebOpenOptions) => void,
): boolean {
  const safe = safeWebUrl(url);
  if (!safe) return false;
  onLink(safe, { forceInApp: true });
  return true;
}

export type ReadWebSourceIcon = (
  sessionId: string,
  runId: string,
  sourceUrl: string,
) => Promise<string | undefined>;

/** The renderer accepts only the main process's bounded, rasterized PNG result. */
export function safeSourceIconData(value: unknown): string | undefined {
  return typeof value === "string" &&
    value.length <= answerSourceLimits.iconData &&
    /^data:image\/png;base64,iVBORw0KGgo[A-Za-z0-9+/]*={0,2}$/u.test(value)
    ? value
    : undefined;
}

/** Share bounded requests between the trigger and popover without touching transcript data. */
export function createAnswerSourceIconLoader(read: ReadWebSourceIcon) {
  const cache = new Map<string, { value?: string; expiresAt: number }>();
  const pending = new Map<string, Promise<string | undefined>>();
  const queue: (() => void)[] = [];
  let active = 0;
  const pump = () => {
    while (active < answerSourceLimits.iconConcurrency && queue.length) queue.shift()?.();
  };
  return (sessionId: string, runId: string, source: AnswerSource): Promise<string | undefined> => {
    const url = safeWebUrl(source.url);
    const siteIcon = safeWebUrl(source.siteIcon);
    if (!sessionId || !runId || !url || !siteIcon) return Promise.resolve(undefined);
    const key = JSON.stringify([sessionId, runId, url, siteIcon]);
    const cached = cache.get(key);
    if (cached && cached.expiresAt > Date.now()) {
      cache.delete(key);
      cache.set(key, cached);
      return Promise.resolve(cached.value);
    }
    cache.delete(key);
    const existing = pending.get(key);
    if (existing) return existing;
    // A pathological history must not create an unbounded queue of IPC requests.
    if (pending.size >= answerSourceLimits.iconCache) return Promise.resolve(undefined);
    let resolve!: (value: string | undefined) => void;
    const result = new Promise<string | undefined>((done) => {
      resolve = done;
    });
    pending.set(key, result);
    queue.push(() => {
      active++;
      void Promise.resolve()
        .then(() => read(sessionId, runId, url))
        .then(safeSourceIconData, () => undefined)
        .then((value) => {
          cache.set(key, {
            value,
            expiresAt: value ? Infinity : Date.now() + answerSourceLimits.iconFailureTtl,
          });
          while (cache.size > answerSourceLimits.iconCache) cache.delete(cache.keys().next().value as string);
          pending.delete(key);
          active--;
          resolve(value);
          pump();
        });
    });
    pump();
    return result;
  };
}

const iconLoaders = new WeakMap<ReadWebSourceIcon, ReturnType<typeof createAnswerSourceIconLoader>>();
export function answerSourceIconLoader(read: ReadWebSourceIcon) {
  let loader = iconLoaders.get(read);
  if (!loader) {
    loader = createAnswerSourceIconLoader(read);
    iconLoaders.set(read, loader);
  }
  return loader;
}
