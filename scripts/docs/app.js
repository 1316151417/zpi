const root = document.documentElement;
const body = document.body;
const THEME_KEY = "zpi-docs-theme";
const docsBase = document.querySelector('meta[name="zpi-docs-base"]')?.getAttribute("content") ?? "";
const docsUrl = (path) => `${docsBase}${path}`;
const isMac = /Mac|iPhone|iPad/.test(navigator.platform) || /Mac OS X/.test(navigator.userAgent);

if (!isMac) {
  for (const key of document.querySelectorAll("kbd")) {
    if (key.textContent.trim() === "⌘K") key.textContent = "Ctrl K";
  }
}

function currentTheme() {
  return root.dataset.theme === "dark" ? "dark" : "light";
}

function applyTheme(theme) {
  root.dataset.theme = theme;
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    // Storage can be unavailable in private modes; the theme still applies.
  }
}

document.getElementById("theme-toggle")?.addEventListener("click", () => {
  applyTheme(currentTheme() === "dark" ? "light" : "dark");
  renderMermaid();
});

document.getElementById("sidebar-toggle")?.addEventListener("click", () => {
  body.classList.toggle("sidebar-open");
});
document.querySelector("[data-sidebar-close]")?.addEventListener("click", () => {
  body.classList.remove("sidebar-open");
});
for (const link of document.querySelectorAll(".nav-item")) {
  link.addEventListener("click", () => body.classList.remove("sidebar-open"));
}

function escapeHtml(value) {
  return String(value).replace(
    /[&<>"']/g,
    (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character],
  );
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function markText(text, query) {
  const escaped = escapeHtml(text);
  if (!query) return escaped;
  return escaped.replace(
    new RegExp(escapeRegExp(escapeHtml(query)), "gi"),
    (match) => `<mark>${match}</mark>`,
  );
}

function snippet(text, query) {
  if (!query) return text.slice(0, 140);
  const index = text.toLowerCase().indexOf(query.toLowerCase());
  if (index < 0) return text.slice(0, 140);
  const start = Math.max(0, index - 40);
  const end = Math.min(text.length, start + 170);
  return `${start > 0 ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`;
}

const modal = document.getElementById("search-modal");
const input = document.getElementById("search-input");
const results = document.getElementById("search-results");
const openButton = document.getElementById("search-open");
let searchIndex;
let searchEntries = [];
let activeIndex = -1;

function loadSearchIndex() {
  searchIndex ??= fetch(docsUrl("/__search.json"))
    .then((response) => {
      if (!response.ok) throw new Error(`搜索索引加载失败（${response.status}）`);
      return response.json();
    })
    .then((data) => {
      searchEntries = Array.isArray(data.entries) ? data.entries : [];
      return searchEntries;
    })
    .catch((error) => {
      searchIndex = undefined;
      throw error;
    });
  return searchIndex;
}

function scoreEntry(entry, query) {
  const needle = query.toLowerCase();
  const heading = (entry.heading || "").toLowerCase();
  const title = entry.title.toLowerCase();
  const text = entry.text.toLowerCase();
  if (!heading.includes(needle) && !title.includes(needle) && !text.includes(needle)) return -1;
  let score = 10;
  if (heading === needle) score += 100;
  else if (heading.startsWith(needle)) score += 70;
  else if (heading.includes(needle)) score += 50;
  if (title.includes(needle)) score += 30;
  score += Math.min(text.split(needle).length - 1, 5) * 4;
  return score;
}

function resultHref(entry) {
  return `${entry.url}${entry.id ? `#${encodeURIComponent(entry.id)}` : ""}`;
}

function resultHtml(entry, query) {
  const heading = entry.heading || entry.title;
  const context = entry.heading ? entry.title : "文档";
  return `<a class="search-result" href="${resultHref(entry)}">
    <span class="search-result-head"><span class="search-result-title">${markText(heading, query)}</span><span class="search-result-context">${escapeHtml(context)}</span></span>
    <span class="search-result-text">${markText(snippet(entry.text, query), query)}</span>
  </a>`;
}

function updateActiveResult() {
  const items = [...results.querySelectorAll(".search-result")];
  items.forEach((item, index) => {
    item.classList.toggle("active", index === activeIndex);
  });
  items[activeIndex]?.scrollIntoView({ block: "nearest" });
}

function renderResults(query) {
  const needle = query.trim();
  if (!needle) {
    results.innerHTML = '<p class="search-empty">输入关键词开始搜索</p>';
    activeIndex = -1;
    return;
  }
  const matches = searchEntries
    .map((entry) => ({ entry, score: scoreEntry(entry, needle) }))
    .filter((match) => match.score >= 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, 20);
  if (!matches.length) {
    results.innerHTML = `<p class="search-empty">没有找到“${escapeHtml(needle)}”</p>`;
    activeIndex = -1;
    return;
  }
  results.innerHTML = matches.map((match) => resultHtml(match.entry, needle)).join("");
  activeIndex = 0;
  updateActiveResult();
}

function openSearch() {
  modal.hidden = false;
  body.classList.add("search-open");
  input.value = "";
  renderResults("");
  input.focus();
  loadSearchIndex()
    .then(() => renderResults(input.value))
    .catch((error) => {
      results.innerHTML = `<p class="search-empty">${escapeHtml(error.message)}</p>`;
    });
}

function closeSearch() {
  modal.hidden = true;
  body.classList.remove("search-open");
  openButton?.focus();
}

openButton?.addEventListener("click", openSearch);
for (const closer of document.querySelectorAll("[data-search-close]")) {
  closer.addEventListener("click", closeSearch);
}

input?.addEventListener("input", () => renderResults(input.value));
input?.addEventListener("keydown", (event) => {
  const items = [...results.querySelectorAll(".search-result")];
  if (event.key === "ArrowDown") {
    event.preventDefault();
    activeIndex = items.length ? (activeIndex + 1) % items.length : -1;
    updateActiveResult();
  } else if (event.key === "ArrowUp") {
    event.preventDefault();
    activeIndex = items.length ? (activeIndex - 1 + items.length) % items.length : -1;
    updateActiveResult();
  } else if (event.key === "Enter") {
    event.preventDefault();
    (items[activeIndex] ?? items[0])?.click();
  } else if (event.key === "Escape") {
    event.preventDefault();
    closeSearch();
  }
});

document.addEventListener("keydown", (event) => {
  const command = isMac ? event.metaKey : event.ctrlKey;
  if (command && event.key.toLowerCase() === "k") {
    event.preventDefault();
    modal.hidden ? openSearch() : closeSearch();
  } else if (event.key === "Escape" && !modal.hidden) {
    closeSearch();
  } else if (
    event.key === "/" &&
    modal.hidden &&
    !/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName)
  ) {
    event.preventDefault();
    openSearch();
  }
});

function fallbackCopy(text) {
  const area = document.createElement("textarea");
  area.value = text;
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.append(area);
  area.select();
  document.execCommand("copy");
  area.remove();
}

for (const pre of document.querySelectorAll(".markdown pre")) {
  const shell = document.createElement("div");
  shell.className = "code-shell";
  pre.before(shell);
  shell.append(pre);
  const button = document.createElement("button");
  button.type = "button";
  button.className = "copy-button";
  button.textContent = "复制";
  button.addEventListener("click", async () => {
    const text = pre.textContent;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      fallbackCopy(text);
    }
    button.textContent = "已复制";
    button.classList.add("copied");
    setTimeout(() => {
      button.textContent = "复制";
      button.classList.remove("copied");
    }, 1600);
  });
  shell.append(button);
}

const mermaidNodes = [...document.querySelectorAll(".mermaid")];
let mermaidLoader;

function loadMermaid() {
  if (window.mermaid) return Promise.resolve(window.mermaid);
  mermaidLoader ??= new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = docsUrl("/__vendor/mermaid.min.js");
    script.onload = () => resolve(window.mermaid);
    script.onerror = () => reject(new Error("Mermaid 资源加载失败"));
    document.head.append(script);
  });
  return mermaidLoader;
}

async function renderMermaid() {
  if (!mermaidNodes.length) return;
  for (const node of mermaidNodes) {
    if (!node.dataset.source) node.dataset.source = node.textContent;
  }
  try {
    const mermaid = await loadMermaid();
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "loose",
      theme: currentTheme() === "dark" ? "dark" : "default",
      fontFamily: 'system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif',
    });
    for (const node of mermaidNodes) {
      node.removeAttribute("data-processed");
      node.classList.remove("mermaid-error");
      node.innerHTML = node.dataset.source;
      try {
        await mermaid.run({ nodes: [node] });
      } catch (error) {
        node.classList.add("mermaid-error");
        node.textContent = node.dataset.source;
        console.error(error);
      }
    }
  } catch (error) {
    console.error(error);
    for (const node of mermaidNodes) node.classList.add("mermaid-error");
  }
}

function setupScrollSpy() {
  const links = [...document.querySelectorAll(".toc-link")];
  if (!links.length) return;
  const byId = new Map(
    links.map((link) => {
      const id = decodeURIComponent(link.hash.slice(1));
      return [id, link];
    }),
  );
  const headings = [...document.querySelectorAll(".markdown h2[id], .markdown h3[id]")];
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        for (const link of links) link.classList.remove("active");
        byId.get(entry.target.id)?.classList.add("active");
      }
    },
    { rootMargin: "-72px 0px -70% 0px", threshold: 0 },
  );
  for (const heading of headings) observer.observe(heading);
}

setupScrollSpy();
renderMermaid();

if (document.querySelector('meta[name="zpi-live"]')) {
  const events = new EventSource(docsUrl("/__events"));
  events.onmessage = (event) => {
    if (event.data === "reload") location.reload();
  };
}
