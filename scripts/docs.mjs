#!/usr/bin/env node
import { spawn } from "node:child_process";
import { watch } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import {
  docUrlForPathname,
  findNeighbors,
  getSite,
  invalidate,
  ROOT,
  readSourceText,
  renderDoc,
  renderSourceFile,
  resolveRepoPath,
} from "./docs/render.mjs";
import { renderDirPage, renderDocPage, renderErrorPage, renderSourcePage } from "./docs/template.mjs";

const here = import.meta.dirname;
const MERMAID_PATH = join(ROOT, "node_modules/mermaid/dist/mermaid.min.js");
const STATIC_ASSETS = new Map([
  ["/__app.js", { file: join(here, "docs/app.js"), type: "text/javascript; charset=utf-8" }],
  ["/__style.css", { file: join(here, "docs/style.css"), type: "text/css; charset=utf-8" }],
]);

const options = parseArgs(process.argv.slice(2));
const sseClients = new Set();
let mermaidGzip;
let watchers = [];
let server;

function parseArgs(argv) {
  const parsed = { port: Number(process.env.PORT) || 4400, open: true, live: true, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--no-open") parsed.open = false;
    else if (argument === "--no-live") parsed.live = false;
    else if (argument === "-h" || argument === "--help") parsed.help = true;
    else if (argument === "--port") parsed.port = Number(argv[++index]);
    else if (argument.startsWith("--port=")) parsed.port = Number(argument.slice("--port=".length));
    else {
      console.error(`未知参数：${argument}`);
      parsed.help = true;
    }
  }
  if (!Number.isInteger(parsed.port) || parsed.port < 1 || parsed.port > 65535) parsed.port = 4400;
  return parsed;
}

function printHelp() {
  console.log(`用法：zpi-docs [选项]

  --port <端口>  监听端口（默认 4400，被占用时自动递增）
  --no-open      不自动打开浏览器
  --no-live      关闭文档变更自动刷新
  -h, --help     显示帮助`);
}

function sendHtml(response, html, status = 200) {
  response.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(html);
}

function redirect(response, location, search = "") {
  response.writeHead(301, { Location: `${location}${search}`, "Cache-Control": "no-store" });
  response.end();
}

async function sendErrorPage(response, status, message) {
  try {
    const site = await getSite();
    sendHtml(
      response,
      renderErrorPage({ site, currentUrl: "", status, message, live: options.live }),
      status,
    );
  } catch {
    response.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
    response.end(message);
  }
}

async function sendStaticAsset(response, asset) {
  const body = await readFile(asset.file);
  response.writeHead(200, {
    "Content-Type": asset.type,
    "Cache-Control": "no-cache",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(body);
}

async function sendMermaid(request, response) {
  const source = await readFile(MERMAID_PATH);
  const acceptsGzip = String(request.headers["accept-encoding"] ?? "").includes("gzip");
  if (!acceptsGzip) {
    response.writeHead(200, {
      "Content-Type": "text/javascript; charset=utf-8",
      "Cache-Control": "public, max-age=3600",
      "X-Content-Type-Options": "nosniff",
    });
    response.end(source);
    return;
  }
  mermaidGzip ??= gzipSync(source);
  response.writeHead(200, {
    "Content-Type": "text/javascript; charset=utf-8",
    "Content-Encoding": "gzip",
    "Cache-Control": "public, max-age=3600",
    Vary: "Accept-Encoding",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(mermaidGzip);
}

async function sendSearchIndex(response) {
  const site = await getSite();
  response.writeHead(200, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(JSON.stringify({ version: site.version, entries: site.search }));
}

function openEventStream(request, response) {
  if (!options.live) {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("live reload disabled");
    return;
  }
  response.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  response.write("retry: 1000\n\n");
  sseClients.add(response);
  request.on("close", () => sseClients.delete(response));
}

async function sendRepoTarget(response, pathname, searchParams) {
  const info = await resolveRepoPath(pathname.slice(1));
  if (info.kind === "missing") {
    await sendErrorPage(response, 404, "页面不存在");
    return;
  }
  if (info.kind === "asset") {
    const body = await readFile(info.absolute);
    response.writeHead(200, {
      "Content-Type": info.contentType,
      "Cache-Control": "public, max-age=60",
      "X-Content-Type-Options": "nosniff",
    });
    response.end(body);
    return;
  }

  const site = await getSite();
  if (info.kind === "dir") {
    sendHtml(
      response,
      renderDirPage({ site, currentUrl: pathname, rel: info.rel, entries: info.entries, live: options.live }),
    );
    return;
  }

  if (searchParams.has("raw")) {
    const text = await readSourceText(info);
    if (text === null) {
      await sendErrorPage(response, 415, "二进制文件无法以文本打开");
      return;
    }
    response.writeHead(200, {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
    response.end(text);
    return;
  }

  const source = await renderSourceFile(info);
  if (source.kind !== "text") {
    await sendErrorPage(response, 415, "无法预览这个文件");
    return;
  }
  sendHtml(
    response,
    renderSourcePage({ site, currentUrl: pathname, source, rel: info.rel, live: options.live }),
  );
}

async function handle(request, response) {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    response.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("bad request");
    return;
  }

  if (
    pathname.includes("\0") ||
    pathname.includes("\\") ||
    pathname.startsWith("//") ||
    pathname.split("/").some((segment) => segment === ".." || segment === ".")
  ) {
    await sendErrorPage(response, 404, "页面不存在");
    return;
  }

  if (pathname.startsWith("/__")) {
    if (pathname === "/__app.js" || pathname === "/__style.css") {
      await sendStaticAsset(response, STATIC_ASSETS.get(pathname));
    } else if (pathname === "/__search.json") {
      await sendSearchIndex(response);
    } else if (pathname === "/__vendor/mermaid.min.js") {
      await sendMermaid(request, response);
    } else if (pathname === "/__events") {
      openEventStream(request, response);
    } else {
      await sendErrorPage(response, 404, "资源不存在");
    }
    return;
  }

  if (pathname.length > 1 && pathname.endsWith("/")) {
    const trimmed = pathname.slice(0, -1);
    redirect(response, trimmed === "/docs" ? "/" : trimmed, url.search);
    return;
  }

  const docRedirect = docUrlForPathname(pathname);
  if (docRedirect) {
    redirect(response, docRedirect, url.search);
    return;
  }
  if (pathname === "/docs") {
    redirect(response, "/", url.search);
    return;
  }
  if (pathname.startsWith("/docs/")) {
    redirect(response, pathname.slice("/docs".length), url.search);
    return;
  }

  const page = await renderDoc(pathname);
  if (page) {
    const site = await getSite();
    sendHtml(
      response,
      renderDocPage({
        site,
        currentUrl: pathname,
        page,
        neighbors: findNeighbors(site, pathname),
        live: options.live,
      }),
    );
    return;
  }

  await sendRepoTarget(response, pathname, url.searchParams);
}

function setupLiveReload() {
  if (!options.live) return;
  let timer;
  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      invalidate();
      for (const client of sseClients) client.write("data: reload\n\n");
    }, 180);
  };
  try {
    watchers.push(watch(join(ROOT, "docs"), { recursive: true }, schedule));
    watchers.push(watch(join(ROOT, "README.md"), schedule));
  } catch (error) {
    console.warn(`无法监听文档变更：${error.message}`);
  }
}

async function listen(port) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port + attempt, "127.0.0.1", () => {
          server.off("error", reject);
          resolve();
        });
      });
      return port + attempt;
    } catch (error) {
      if (error.code !== "EADDRINUSE") throw error;
    }
  }
  throw new Error(`端口 ${port} 起连续 20 个端口都被占用`);
}

function openBrowser(address) {
  if (!options.open || process.env.CI || !process.stdout.isTTY) return;
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", address] : [address];
  const child = spawn(command, args, { detached: true, stdio: "ignore" });
  child.on("error", () => {});
  child.unref();
}

async function main() {
  if (options.help) {
    printHelp();
    return;
  }

  const site = await getSite();
  server = createServer((request, response) => {
    handle(request, response).catch(async (error) => {
      console.error(error);
      if (!response.headersSent) await sendErrorPage(response, 500, "服务器内部错误");
      else response.destroy();
    });
  });
  setupLiveReload();

  const port = await listen(options.port);
  const address = `http://127.0.0.1:${port}`;
  console.log(`ZPI 文档已启动：${address}`);
  console.log(`${site.docs.length} 篇文档 · ${site.search.length} 个搜索段落`);
  openBrowser(address);
}

function shutdown() {
  for (const watcher of watchers) watcher.close();
  watchers = [];
  for (const client of sseClients) client.end();
  sseClients.clear();
  server?.close();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await main();
