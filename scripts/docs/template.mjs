import { escapeAttr, escapeHtml } from "./html.mjs";

const REPO_URL = "https://github.com/1316151417/zpi";

function withBase(site, path) {
  return site.base && path.startsWith("/") ? `${site.base}${path}` : path;
}

const ICONS = {
  menu: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h16"/></svg>',
  search:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>',
  sun: '<svg class="icon-sun" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>',
  moon: '<svg class="icon-moon" viewBox="0 0 24 24" aria-hidden="true"><path d="M20 14.5A8 8 0 0 1 9.5 4a7 7 0 1 0 10.5 10.5Z"/></svg>',
  github:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2a10 10 0 0 0-3.2 19.5c.5.1.7-.2.7-.5v-1.7c-2.8.6-3.4-1.2-3.4-1.2-.4-1.2-1.1-1.5-1.1-1.5-.9-.6.1-.6.1-.6 1 .1 1.5 1 1.5 1 .9 1.5 2.3 1.1 2.9.8.1-.6.4-1.1.7-1.3-2.2-.3-4.6-1.1-4.6-5 0-1.1.4-2 1-2.7-.1-.3-.4-1.3.1-2.7 0 0 .8-.3 2.7 1a9.4 9.4 0 0 1 5 0c1.9-1.3 2.7-1 2.7-1 .5 1.4.2 2.4.1 2.7.6.7 1 1.6 1 2.7 0 3.9-2.4 4.7-4.6 5 .4.3.7 1 .7 2v3c0 .3.2.6.7.5A10 10 0 0 0 12 2Z"/></svg>',
  prev: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 18l-6-6 6-6"/></svg>',
  next: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 18l6-6-6-6"/></svg>',
};

function sidebarHtml(site, currentUrl) {
  return site.sidebar
    .map(
      (group) =>
        `<div class="nav-group"><div class="nav-label">${escapeHtml(group.label)}</div>${group.items
          .map((doc) => {
            const active = doc.url === currentUrl;
            return `<a class="nav-item${active ? " active" : ""}" href="${escapeAttr(withBase(site, doc.url))}"${
              active ? ' aria-current="page"' : ""
            }>${escapeHtml(doc.title)}</a>`;
          })
          .join("")}</div>`,
    )
    .join("");
}

function tocHtml(toc) {
  if (!toc.length) return "";
  return `<div class="toc-inner"><div class="toc-label">本页目录</div>${toc
    .map(
      (entry) =>
        `<a class="toc-link depth-${entry.depth}" href="#${escapeAttr(entry.id)}">${escapeHtml(entry.text)}</a>`,
    )
    .join("")}</div>`;
}

function pagerHtml(site, neighbors) {
  const prev = neighbors?.prev
    ? `<a class="pager-link pager-prev" href="${escapeAttr(withBase(site, neighbors.prev.url))}">${ICONS.prev}<span><small>上一篇</small><strong>${escapeHtml(neighbors.prev.title)}</strong></span></a>`
    : "<span></span>";
  const next = neighbors?.next
    ? `<a class="pager-link pager-next" href="${escapeAttr(withBase(site, neighbors.next.url))}"><span><small>下一篇</small><strong>${escapeHtml(neighbors.next.title)}</strong></span>${ICONS.next}</a>`
    : "<span></span>";
  return `<nav class="pager" aria-label="翻页">${prev}${next}</nav>`;
}

function heroHtml(site) {
  return `<section class="hero">
  <p class="eyebrow">DOCUMENTATION</p>
  <h1>ZPI 文档</h1>
  <p class="lede">四工具内核、共享 TypeScript SDK 与按需使用的系统内置插件。查阅功能用法、实现原理和开发约定。</p>
  <div class="hero-actions">
    <a class="button primary" href="${escapeAttr(withBase(site, "/features/getting-started"))}">新手向导</a>
    <a class="button" href="${escapeAttr(withBase(site, "/features/plugins"))}">插件与能力</a>
    <a class="button" href="${escapeAttr(withBase(site, "/design"))}">总览设计</a>
    <a class="button" href="${escapeAttr(withBase(site, "/internals/module-map"))}">源码地图</a>
  </div>
</section>`;
}

function shell({
  site,
  currentUrl,
  documentTitle,
  content,
  toc = [],
  isHome = false,
  mainClass = "",
  live = true,
  description = "ZPI 文档",
}) {
  const tocMarkup = toc.length ? `<aside class="toc" aria-label="本页目录">${tocHtml(toc)}</aside>` : "";
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="description" content="${escapeAttr(description)}">
  <meta name="zpi-docs-base" content="${escapeAttr(site.base ?? "")}">
  ${live ? '<meta name="zpi-live" content="1">' : ""}
  <title>${escapeHtml(documentTitle)} · ZPI 文档</title>
  <link rel="stylesheet" href="${escapeAttr(withBase(site, "/__style.css"))}">
  <script>
    try {
      const stored = localStorage.getItem("zpi-docs-theme");
      document.documentElement.dataset.theme =
        stored || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
    } catch {
      document.documentElement.dataset.theme = "light";
    }
  </script>
</head>
<body>
  <header class="topbar">
    <button id="sidebar-toggle" class="icon-button menu-button" type="button" aria-label="打开导航">${ICONS.menu}</button>
    <a class="brand" href="${escapeAttr(withBase(site, "/"))}">
      <span class="brand-mark">Z</span>
      <span class="brand-name">ZPI 文档</span>
      <span class="brand-version">v${escapeHtml(site.version)}</span>
    </a>
    <div class="topbar-spacer"></div>
    <button id="search-open" class="search-trigger" type="button" aria-label="搜索文档">
      ${ICONS.search}<span>搜索文档</span><kbd>⌘K</kbd>
    </button>
    <a class="topbar-link" href="${escapeAttr(site.intro)}">介绍页</a>
    <button id="theme-toggle" class="icon-button" type="button" aria-label="切换深浅色">${ICONS.sun}${ICONS.moon}</button>
    <a class="icon-button" href="${REPO_URL}" target="_blank" rel="noopener" aria-label="GitHub 仓库">${ICONS.github}</a>
  </header>
  <div class="layout${tocMarkup ? "" : " no-toc"}">
    <aside id="sidebar" class="sidebar">
      <nav aria-label="文档导航">${sidebarHtml(site, currentUrl)}</nav>
      <div class="sidebar-foot">v${escapeHtml(site.version)} · <a href="${escapeAttr(site.intro)}">项目介绍</a></div>
    </aside>
    <div class="sidebar-scrim" data-sidebar-close></div>
    <main class="content${isHome ? " home" : ""}${mainClass ? ` ${mainClass}` : ""}">
      ${content}
      <footer class="site-foot">
        <span>ZPI 文档</span>
        <a href="${escapeAttr(site.intro)}">项目介绍</a>
        <a href="${REPO_URL}" target="_blank" rel="noopener">GitHub 仓库</a>
      </footer>
    </main>
    ${tocMarkup}
  </div>
  <div id="search-modal" class="search-modal" hidden>
    <div class="search-backdrop" data-search-close></div>
    <div class="search-panel" role="dialog" aria-modal="true" aria-label="搜索文档">
      <div class="search-input-row">
        ${ICONS.search}
        <input id="search-input" type="search" placeholder="搜索标题、正文…" autocomplete="off" spellcheck="false">
        <kbd>Esc</kbd>
      </div>
      <div id="search-results" class="search-results">
        <p class="search-empty">输入关键词开始搜索</p>
      </div>
      <div class="search-footer">
        <span><kbd>↑</kbd><kbd>↓</kbd> 选择</span>
        <span><kbd>Enter</kbd> 打开</span>
        <span><kbd>⌘K</kbd> 关闭</span>
      </div>
    </div>
  </div>
  <script type="module" src="${escapeAttr(withBase(site, "/__app.js"))}"></script>
</body>
</html>`;
}

export function renderDocPage({ site, currentUrl, page, neighbors, live }) {
  const content = `${currentUrl === "/" ? heroHtml(site) : ""}<article class="markdown">${page.html}</article>${pagerHtml(site, neighbors)}`;
  return shell({
    site,
    currentUrl,
    documentTitle: page.title,
    description: `${page.title} · ZPI 文档`,
    content,
    toc: page.toc,
    isHome: currentUrl === "/",
    live,
  });
}

export function renderSourcePage({ site, currentUrl, source, rel, live }) {
  const meta = [
    `<span class="badge">${escapeHtml(source.lang)}</span>`,
    `<span>${source.lines} 行</span>`,
    source.truncated ? '<span class="badge warn">已截断</span>' : "",
    `<a href="${escapeAttr(withBase(site, `/${rel}?raw`))}">查看原文</a>`,
  ]
    .filter(Boolean)
    .join("");
  const content = `<section class="source-head">
  <div>
    <p class="eyebrow">源码</p>
    <h1>${escapeHtml(rel)}</h1>
  </div>
  <div class="source-meta">${meta}</div>
</section>
<div class="source-body">${source.html}</div>`;
  return shell({
    site,
    currentUrl,
    documentTitle: rel,
    description: `${rel} · ZPI 源码`,
    content,
    mainClass: "source-page",
    live,
  });
}

export function renderDirPage({ site, currentUrl, rel, entries, live }) {
  const hidden = new Set(["node_modules", ".git", "release", "test-results", ".qoder", ".probe"]);
  const sorted = [...entries]
    .filter((entry) => !hidden.has(entry.name))
    .sort(
      (left, right) =>
        Number(right.isDirectory()) - Number(left.isDirectory()) || left.name.localeCompare(right.name),
    );
  const items = sorted
    .map((entry) => {
      const path = (rel ? `${rel}/` : "") + entry.name;
      const href = `/${path.split("/").map(encodeURIComponent).join("/")}${entry.isDirectory() ? "/" : ""}`;
      return `<li class="${entry.isDirectory() ? "dir" : "file"}"><a href="${escapeAttr(withBase(site, href))}">${escapeHtml(entry.name)}${
        entry.isDirectory() ? "/" : ""
      }</a></li>`;
    })
    .join("");
  const content = `<section class="dir-page">
  <p class="eyebrow">目录</p>
  <h1>/${escapeHtml(rel)}</h1>
  <ul class="dir-list">${items || '<li class="empty">空目录</li>'}</ul>
</section>`;
  return shell({
    site,
    currentUrl,
    documentTitle: `/${rel}`,
    description: `/${rel} · ZPI 目录`,
    content,
    mainClass: "listing",
    live,
  });
}

export function renderErrorPage({ site, currentUrl, status, message, live }) {
  const content = `<section class="error-page">
  <p class="eyebrow">${status}</p>
  <h1>${escapeHtml(message)}</h1>
  <p>没有找到这个页面。可以返回 <a href="${escapeAttr(withBase(site, "/"))}">文档首页</a>，或使用 <kbd>⌘K</kbd> 搜索。</p>
</section>`;
  return shell({
    site,
    currentUrl,
    documentTitle: message,
    description: message,
    content,
    mainClass: "error",
    live,
  });
}
