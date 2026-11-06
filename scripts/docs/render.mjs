import { existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { extname, join, posix, relative, resolve, sep } from "node:path";
import { Marked } from "marked";
import { createHighlighter } from "shiki";
import { escapeAttr, escapeHtml, headingText, makeSlugger, stripMarkdown } from "./html.mjs";

export const ROOT = resolve(import.meta.dirname, "../..");
export const DOCS = join(ROOT, "docs");
const README = join(ROOT, "README.md");
const MAX_SOURCE_BYTES = 400_000;
const SHIKI_THEMES = { light: "github-light", dark: "github-dark" };

const DENIED_SEGMENTS = new Set(["node_modules", ".git", "release", "test-results", ".qoder", ".probe"]);

const ASSET_TYPES = new Map([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".gif", "image/gif"],
  [".svg", "image/svg+xml"],
  [".webp", "image/webp"],
  [".ico", "image/x-icon"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
  [".ttf", "font/ttf"],
  [".otf", "font/otf"],
  [".pdf", "application/pdf"],
  [".wasm", "application/wasm"],
]);

const EXT_LANGS = new Map([
  [".ts", "typescript"],
  [".mts", "typescript"],
  [".tsx", "tsx"],
  [".js", "javascript"],
  [".mjs", "javascript"],
  [".cjs", "javascript"],
  [".jsx", "jsx"],
  [".json", "json"],
  [".css", "css"],
  [".scss", "scss"],
  [".less", "less"],
  [".html", "html"],
  [".md", "markdown"],
  [".yml", "yaml"],
  [".yaml", "yaml"],
  [".toml", "toml"],
  [".sh", "bash"],
  [".diff", "diff"],
  [".patch", "diff"],
  [".py", "python"],
  [".go", "go"],
  [".rs", "rust"],
  [".java", "java"],
  [".c", "c"],
  [".h", "c"],
  [".cpp", "cpp"],
  [".sql", "sql"],
  [".xml", "xml"],
]);

const LANG_ALIASES = new Map([
  ["sh", "bash"],
  ["shell", "bash"],
  ["zsh", "bash"],
  ["ts", "typescript"],
  ["js", "javascript"],
  ["mjs", "javascript"],
  ["md", "markdown"],
  ["yml", "yaml"],
  ["text", null],
  ["txt", null],
  ["plaintext", null],
]);

let highlighterPromise;
const loadedLanguages = new Set();

async function getHighlighter() {
  highlighterPromise ??= createHighlighter({ themes: Object.values(SHIKI_THEMES) });
  return highlighterPromise;
}

function resolveLanguage(lang) {
  if (!lang) return null;
  const name = String(lang).toLowerCase().trim();
  if (LANG_ALIASES.has(name)) return LANG_ALIASES.get(name);
  return EXT_LANGS.get(`.${name}`) ?? (name.length > 0 ? name : null);
}

function plainCode(code, trimmed = false) {
  const source = trimmed ? code.replace(/\n$/, "") : code;
  const lines = source.split("\n");
  const body = lines.map((line) => `<span class="line">${escapeHtml(line) || " "}</span>`).join("\n");
  return `<pre class="shiki-plain"><code>${body}</code></pre>`;
}

async function highlight(code, lang, { trim = false } = {}) {
  const name = resolveLanguage(lang);
  if (!name) return plainCode(code, trim);
  try {
    const highlighter = await getHighlighter();
    if (!loadedLanguages.has(name)) {
      await highlighter.loadLanguage(name);
      loadedLanguages.add(name);
    }
    return await highlighter.codeToHtml(code, {
      lang: name,
      themes: SHIKI_THEMES,
      defaultColor: false,
    });
  } catch {
    return plainCode(code, trim);
  }
}

function normalizeBase(urlPath) {
  if (urlPath === "/") return "/";
  return urlPath.slice(0, urlPath.lastIndexOf("/") + 1) || "/";
}

export function resolveLocalLink(href, urlPath) {
  if (!href) return urlPath;
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("//") || href.startsWith("#")) {
    return href;
  }

  const hashIndex = href.indexOf("#");
  const hash = hashIndex >= 0 ? href.slice(hashIndex) : "";
  let path = hashIndex >= 0 ? href.slice(0, hashIndex) : href;
  const queryIndex = path.indexOf("?");
  const query = queryIndex >= 0 ? path.slice(queryIndex) : "";
  if (queryIndex >= 0) path = path.slice(0, queryIndex);

  let resolved = path.startsWith("/")
    ? posix.normalize(path)
    : posix.normalize(posix.join(normalizeBase(urlPath), path));
  if (!resolved.startsWith("/")) resolved = `/${resolved}`;
  if (resolved === "/README.md") resolved = "/";
  else if (resolved.startsWith("/docs/")) resolved = resolved.slice("/docs".length);
  if (resolved.endsWith(".md")) resolved = resolved.slice(0, -3);
  if (resolved === "") resolved = "/";
  return `${resolved}${query}${hash}`;
}

function markdownLink(href, urlPath, label, title, external) {
  const titleAttr = title ? ` title="${escapeAttr(title)}"` : "";
  const target = external ? ' target="_blank" rel="noopener"' : "";
  return `<a href="${escapeAttr(resolveLocalLink(href, urlPath))}"${titleAttr}${target}>${label}</a>`;
}

export async function renderMarkdown(markdown, urlPath) {
  const slug = makeSlugger();
  const toc = [];
  const codeBlocks = [];
  let title = "";
  const marker = `ZPI_CODE_${Math.random().toString(36).slice(2)}_`;

  const instance = new Marked({ gfm: true });
  instance.use({
    renderer: {
      heading(token) {
        const label = headingText(token.text);
        if (token.depth === 1 && !title) title = label;
        const id = slug(token.text);
        if (token.depth === 2 || token.depth === 3) toc.push({ depth: token.depth, id, text: label });
        const inner = this.parser.parseInline(token.tokens);
        const anchor =
          token.depth >= 2
            ? `<a class="heading-anchor" href="#${escapeAttr(id)}" aria-hidden="true">#</a>`
            : "";
        return `<h${token.depth} id="${escapeAttr(id)}">${anchor}${inner}</h${token.depth}>\n`;
      },
      code(token) {
        if ((token.lang ?? "").toLowerCase() === "mermaid") {
          return `<div class="mermaid">${escapeHtml(token.text)}</div>\n`;
        }
        const index = codeBlocks.length;
        codeBlocks.push({ text: token.text, lang: token.lang });
        return `\u0000${marker}${index}\u0000\n`;
      },
      link(token) {
        const label = this.parser.parseInline(token.tokens);
        const external = /^(?:https?:)?\/\//i.test(token.href);
        return markdownLink(token.href, urlPath, label, token.title, external);
      },
      image(token) {
        const titleAttr = token.title ? ` title="${escapeAttr(token.title)}"` : "";
        return `<img src="${escapeAttr(resolveLocalLink(token.href, urlPath))}" alt="${escapeAttr(token.text)}"${titleAttr}>`;
      },
    },
  });

  let html = instance.parse(markdown);
  for (const [index, block] of codeBlocks.entries()) {
    const rendered = await highlight(block.text, block.lang, { trim: true });
    html = html.replaceAll(`\u0000${marker}${index}\u0000`, rendered);
  }
  html = html.replace(/<table>/g, '<div class="table-wrap"><table>').replace(/<\/table>/g, "</table></div>");
  return { title: title || "文档", html, toc };
}

async function walkMarkdown(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await walkMarkdown(absolute)));
    else if (entry.name.endsWith(".md")) files.push(absolute);
  }
  return files;
}

async function readDocMeta(file) {
  const text = await readFile(file, "utf8");
  const tokens = new Marked({ gfm: true }).lexer(text);
  const heading = tokens.find((token) => token.type === "heading" && token.depth === 1);
  const isReadme = file === README;
  const rel = isReadme ? "README.md" : relative(DOCS, file).replaceAll(sep, "/");
  const docsRel = isReadme ? "" : rel;
  const group = isReadme
    ? "home"
    : docsRel.startsWith("features/")
      ? "features"
      : docsRel.startsWith("internals/")
        ? "internals"
        : "overview";
  return {
    file,
    text,
    title: heading ? headingText(heading.text) : rel.replace(/\.md$/, ""),
    url: isReadme ? "/" : `/${docsRel.replace(/\.md$/, "")}`,
    relPath: isReadme ? "README.md" : `docs/${docsRel}`,
    group,
    order: Number.MAX_SAFE_INTEGER,
  };
}

function buildSearchEntries(docs) {
  const entries = [];
  for (const doc of docs) {
    const slug = makeSlugger();
    let current = { id: "", heading: "", parts: [] };
    const flush = () => {
      const text = stripMarkdown(current.parts.join(" ")).slice(0, 260);
      if (text)
        entries.push({ url: doc.url, title: doc.title, id: current.id, heading: current.heading, text });
    };
    for (const token of new Marked({ gfm: true }).lexer(doc.text)) {
      if (token.type === "heading") {
        flush();
        if (token.depth === 1) {
          current = { id: "", heading: "", parts: [] };
        } else {
          current = { id: slug(token.text), heading: headingText(token.text), parts: [] };
        }
        continue;
      }
      if (token.type === "code") continue;
      if (["paragraph", "blockquote", "list", "table", "html", "text"].includes(token.type)) {
        current.parts.push(token.raw ?? "");
      }
    }
    flush();
  }
  return entries;
}

let sitePromise;
let docCache = new Map();
let sourceCache = new Map();

async function buildSite() {
  const files = [README, ...(await walkMarkdown(DOCS))];
  const docs = await Promise.all(files.map((file) => readDocMeta(file)));
  const byUrl = new Map(docs.map((doc) => [doc.url, doc]));

  const readme = docs.find((doc) => doc.group === "home");
  const order = new Map();
  for (const match of readme.text.matchAll(/\]\(([^)]+)\)/g)) {
    if (!match[1].endsWith(".md")) continue;
    const target = resolveLocalLink(match[1], "/").replace(/^\//, "");
    if (target && !order.has(target)) order.set(target, order.size);
  }
  for (const doc of docs) {
    if (doc.group === "home") continue;
    const key = doc.url.slice(1);
    doc.order = order.get(key) ?? Number.MAX_SAFE_INTEGER;
  }

  const sortGroup = (group) =>
    docs
      .filter((doc) => doc.group === group)
      .sort((left, right) => left.order - right.order || left.title.localeCompare(right.title, "zh-CN"));

  const sidebar = [
    { label: "首页", items: sortGroup("home") },
    { label: "概览", items: sortGroup("overview") },
    { label: "功能", items: sortGroup("features") },
    { label: "原理", items: sortGroup("internals") },
  ].filter((group) => group.items.length > 0);

  const version = await readVersion();
  return {
    docs,
    byUrl,
    sidebar,
    linear: sidebar.flatMap((group) => group.items),
    version,
    search: buildSearchEntries(docs),
  };
}

let versionPromise;
function readVersion() {
  versionPromise ??= readFile(join(ROOT, "package.json"), "utf8").then((text) => JSON.parse(text).version);
  return versionPromise;
}

export function getSite() {
  sitePromise ??= buildSite();
  return sitePromise;
}

export function invalidate() {
  sitePromise = undefined;
  versionPromise = undefined;
  docCache = new Map();
  sourceCache = new Map();
}

export function findNeighbors(site, urlPath) {
  const index = site.linear.findIndex((doc) => doc.url === urlPath);
  if (index < 0) return { prev: null, next: null };
  return { prev: site.linear[index - 1] ?? null, next: site.linear[index + 1] ?? null };
}

export async function renderDoc(urlPath) {
  const site = await getSite();
  const doc = site.byUrl.get(urlPath);
  if (!doc) return null;

  const info = await stat(doc.file);
  const cached = docCache.get(doc.file);
  if (cached && cached.mtimeMs === info.mtimeMs && cached.urlPath === urlPath) return cached.page;

  const markdown = await readFile(doc.file, "utf8");
  const rendered = await renderMarkdown(markdown, urlPath);
  const page = { ...rendered, title: rendered.title || doc.title, doc };
  docCache.set(doc.file, { mtimeMs: info.mtimeMs, urlPath, page });
  return page;
}

export async function resolveRepoPath(repoPath) {
  const absolute = resolve(ROOT, repoPath);
  if (absolute !== ROOT && !absolute.startsWith(ROOT + sep)) return { kind: "missing" };
  const rel = relative(ROOT, absolute).replaceAll(sep, "/");
  const segments = rel.split("/");
  if (segments.some((segment) => DENIED_SEGMENTS.has(segment))) return { kind: "missing" };

  let info;
  try {
    info = await stat(absolute);
  } catch {
    return { kind: "missing" };
  }
  if (info.isDirectory()) {
    return { kind: "dir", absolute, rel, entries: await readdir(absolute, { withFileTypes: true }) };
  }
  const extension = extname(absolute).toLowerCase();
  const contentType = ASSET_TYPES.get(extension);
  if (contentType) return { kind: "asset", absolute, rel, contentType, size: info.size };
  return { kind: "file", absolute, rel, size: info.size, mtimeMs: info.mtimeMs, extension };
}

export async function renderSourceFile(info) {
  const cached = sourceCache.get(info.rel);
  if (cached && cached.mtimeMs === info.mtimeMs && cached.size === info.size) return cached.value;

  const buffer = await readFile(info.absolute);
  if (buffer.includes(0)) return { kind: "binary" };

  let code = buffer.toString("utf8");
  let truncated = false;
  if (code.length > MAX_SOURCE_BYTES) {
    code = code.slice(0, MAX_SOURCE_BYTES);
    truncated = true;
  }
  const lang = EXT_LANGS.get(info.extension) ?? null;
  const value = {
    kind: "text",
    html: await highlight(code, lang, { trim: true }),
    lang: lang ?? "text",
    lines: code.split("\n").length,
    truncated,
  };
  sourceCache.set(info.rel, { mtimeMs: info.mtimeMs, size: info.size, value });
  if (sourceCache.size > 40) sourceCache.delete(sourceCache.keys().next().value);
  return value;
}

export async function readSourceText(info) {
  const buffer = await readFile(info.absolute);
  return buffer.includes(0) ? null : buffer.toString("utf8");
}

export function docUrlForPathname(pathname) {
  if (pathname === "/README.md") return "/";
  let candidate = pathname;
  if (candidate === "/docs") return "/";
  if (candidate.startsWith("/docs/")) candidate = candidate.slice("/docs".length);
  if (candidate.endsWith(".md")) {
    const relativePath = candidate.slice(1);
    if (existsSync(join(DOCS, relativePath))) return `/${relativePath.slice(0, -3)}`;
  }
  return null;
}
