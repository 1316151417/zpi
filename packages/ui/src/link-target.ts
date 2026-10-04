export interface LinkContext {
  cwd?: string;
  home?: string;
}
export interface FileLocation {
  line?: number;
  column?: number;
  endLine?: number;
  relative?: boolean;
  fileUrl?: string;
}
export interface WebOpenOptions {
  forceExternal?: boolean;
  forceInApp?: boolean;
}
export type LinkTarget = ({ kind: "file"; path: string } & FileLocation) | { kind: "web"; url: string };

const absolute = (path: string) => /^(?:\/|[a-z]:\/)/i.test(path);
function normalize(path: string, bounded = false): string | null {
  const prefix =
    /^[a-z]:\//i.exec(path)?.[0] ?? (path.startsWith("//") ? "//" : path.startsWith("/") ? "/" : "");
  const segments: string[] = [];
  for (const part of path.slice(prefix.length).split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (!segments.length) {
        if (bounded) return null;
      } else segments.pop();
    } else segments.push(part);
  }
  return prefix + segments.join("/");
}
function stripQuotes(path: string): string {
  const pairs: Record<string, string> = { '"': '"', "'": "'", "“": "”", "‘": "’" };
  return pairs[path[0]] === path.at(-1) ? path.slice(1, -1) : path;
}
export function resolveLinkTarget(raw: string, context: LinkContext = {}): LinkTarget | null {
  if (!raw || raw.length > 8192 || /[\0\r\n]/.test(raw)) return null;
  let path = stripQuotes(raw.trim());
  if (/^https?:/i.test(path)) {
    try {
      const url = new URL(path);
      return url.hostname && !url.username && !url.password ? { kind: "web", url: url.href } : null;
    } catch {
      return null;
    }
  }
  const location: FileLocation = {};
  const suffix = /#L(\d+)(?:-L?(\d+))?$/i.exec(path) ?? /:(\d+)(?::(\d+))?$/.exec(path);
  if (suffix) {
    const line = Number(suffix[1]),
      other = suffix[2] ? Number(suffix[2]) : undefined;
    if (
      !Number.isSafeInteger(line) ||
      line < 1 ||
      (other !== undefined && (!Number.isSafeInteger(other) || other < 1))
    )
      return null;
    location.line = line;
    if (suffix[0].startsWith("#")) {
      if (other !== undefined && other < line) return null;
      location.endLine = other;
    } else location.column = other;
    path = path.slice(0, suffix.index);
  }
  if (/^file:/i.test(path)) {
    try {
      const url = new URL(path);
      if (url.username || url.password || url.port) return null;
      if (url.search || url.hash) location.fileUrl = url.href;
      path = (url.hostname && url.hostname !== "localhost" ? `//${url.hostname}` : "") + url.pathname;
      if (/^\/[a-z]:\//i.test(path)) path = path.slice(1);
    } catch {
      return null;
    }
  } else if (/^[a-z][a-z\d+.-]*:/i.test(path) && !/^[a-z]:[\\/]/i.test(path)) return null;
  if (!path || path.startsWith("#") || /[?#]/.test(path) || /%(?:2f|5c)/i.test(path)) return null;
  try {
    path = stripQuotes(decodeURIComponent(path)).replace(/\\/g, "/");
  } catch {
    return null;
  }
  if (/[\0\r\n]/.test(path) || (/^[a-z][a-z\d+.-]*:/i.test(path) && !/^[a-z]:\//i.test(path))) return null;
  if (path.startsWith("./~/")) path = path.slice(2);
  if (path.startsWith("~")) {
    if (!path.startsWith("~/") || !context.home || !absolute(context.home.replace(/\\/g, "/"))) return null;
    const tail = normalize(path.slice(2), true);
    return tail === null
      ? null
      : { kind: "file", path: `${context.home.replace(/\\/g, "/").replace(/\/$/, "")}/${tail}`, ...location };
  }
  if (absolute(path)) return { kind: "file", path: normalize(path) as string, ...location };
  // Bare destinations must look like a file or path, rather than a fragment or a word.
  if (
    !path.includes("/") &&
    !path.includes(".") &&
    !/^(?:README|LICENSE|Makefile|Dockerfile|Gemfile)$/i.test(path)
  )
    return null;
  const tail = normalize(path, true),
    cwd = context.cwd?.replace(/\\/g, "/").replace(/\/$/, "");
  return tail && cwd && absolute(cwd)
    ? { kind: "file", path: `${cwd}/${tail}`, ...location, relative: true }
    : null;
}

export function webOpenTarget(url: string, options: WebOpenOptions = {}): "app-browser" | "external-browser" {
  if (options.forceExternal) return "external-browser";
  if (options.forceInApp) return "app-browser";
  const host = new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (
    host === "localhost" ||
    host === "localhost.localdomain" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".test") ||
    host === "::1" ||
    host === "0:0:0:0:0:0:0:1"
  )
    return "app-browser";
  const octets = host.split("."),
    parts = octets.map(Number);
  if (
    parts.length === 4 &&
    parts.every((part, index) => /^\d+$/.test(octets[index]) && part >= 0 && part <= 255)
  ) {
    const [a, b, c, d] = parts;
    if (
      a === 127 ||
      a === 10 ||
      (a === 0 && b === 0 && c === 0 && d === 0) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254)
    )
      return "app-browser";
  }
  return "external-browser";
}
