// Render the checked-out ZCode file launcher/tree and ZPI components with their own styles and icons.
// node scripts/verify-file-manager-parity.mjs /path/to/ZCode

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import tailwind from "@tailwindcss/vite";
import { build as bundle } from "esbuild";
import sharp from "sharp";
import { build as viteBuild } from "vite";
import { launchDesktop } from "../tests/helpers/desktop.ts";
import { desktopScope } from "../tests/helpers/desktop-scope.ts";
import { assertBackgroundCommand } from "../tests/helpers/test-command.ts";
import safetyCheck from "../tests/safety-check.ts";

assertBackgroundCommand(process.argv.slice(2));
const root = process.cwd();
const reference = resolve(process.argv[2] ?? "/Users/jiezhou/VSCodeProjects/ZCode");
const ui = join(reference, "packages/ui/src");
const output = resolve("release/file-manager-parity");
await mkdir(output, { recursive: true });
const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: reference, encoding: "utf8" }).trim();
const ownRequire = createRequire(join(root, "package.json"));
const refRequire = createRequire(join(reference, "package.json"));
const common = `import React,{useState} from 'react';import {createRoot} from 'react-dom/client';import {LucideProvider} from 'lucide-react';
const params=new URLSearchParams(location.search);const theme=params.get('theme')??'light';const width=Number(params.get('width')??280);const size=Number(params.get('size')??14);const kind=params.get('kind')??'tree';
document.documentElement.className=theme==='dark'?'dark theme-zai-dark':'theme-zai-light';document.documentElement.dataset.theme=theme;document.documentElement.style.colorScheme=theme;document.body.style.background=theme==='dark'?'#161616':'#f0f0f0';document.documentElement.style.setProperty('--ui-font-size',size+'px');document.documentElement.style.setProperty('--ui-font-size-sm',(size-2)+'px');
`;
const rowFile = join(ui, "plugin-ui/components/PluginUiLauncherItems.tsx");
const sourceRow = (await readFile(rowFile, "utf8")).split("export function SidePaneLauncherRow(")[1];
if (!sourceRow) throw new Error("ZCode launcher component not found");
await writeFile(
  join(output, "reference-row.tsx"),
  `import React from 'react';import type {ReactNode} from 'react';import type {LucideIcon} from 'lucide-react';import {buttonVariants} from ${JSON.stringify(join(ui, "components/ui/button.tsx"))};import {cn} from ${JSON.stringify(join(ui, "components/lib/utils.ts"))};import {useZCodeIntl} from '@/i18n/IntlProvider.js';const Spinner=()=>null;export function SidePaneLauncherRow(${sourceRow}`,
);
const fixtureData = `export const rows=[{path:'/workspace/src',name:'src',type:'directory',depth:0,expanded:true,loaded:true,loading:false,error:null},{path:'/workspace/src/index.ts',name:'index.ts',type:'file',depth:1,expanded:false,loaded:false,loading:false,error:null},{path:'/workspace/.env',name:'.env',type:'file',depth:0,expanded:false,loaded:false,loading:false,error:null},{path:'/workspace/README.md',name:'README.md',type:'file',depth:0,expanded:false,loaded:false,loading:false,error:null}];
export const data={rows,loadedDirectoryPaths:new Set(['/workspace','/workspace/src']),loadingDirectoryPaths:new Set(),errorByDirectory:new Map(),gitStatusByPath:new Map([['/workspace/src/index.ts','modified']]),gitStatusAvailable:true,ignoredPathSet:new Set(),refreshingLoadedDirectories:false,loadDirectory:async()=>{},loadGitStatus:async()=>{},refreshLoadedDirectories:async()=>{},setExpandedPaths:()=>{}};
`;
const entries = {
  ref:
    common +
    `import {SidePaneLauncherRow} from './reference-row.tsx';import {FolderOpen,Globe,SquareTerminal,FileDiff} from 'lucide-react';import {WorkspaceFileTree} from ${JSON.stringify(join(ui, "workspace-file-tree/WorkspaceFileTree.tsx"))};function App(){return kind==='launcher'?<div className="fixture" style={{width}}><div className="side-pane-open-tab-shell @container/launcher flex h-full min-h-0 flex-col bg-background"><div className="min-h-0 flex-1 overflow-y-auto px-7 py-6"><div className="mx-auto flex w-full max-w-3xl flex-col gap-6"><h2 className="pl-2 text-ui-xl font-semibold text-foreground">新标签页</h2><div className="grid min-w-0 grid-cols-1 gap-x-8 gap-y-1 @min-[36rem]/launcher:grid-cols-2">{[['files',FolderOpen,'文件','从目录中选择一个文件'],['browser',Globe,'浏览器','浏览网页和预览应用。'],['terminal',SquareTerminal,'终端','运行命令和查看输出。'],['review',FileDiff,'审查','查看代码变更与差异。']].map(([id,icon,label,description])=><SidePaneLauncherRow key={id} itemId={id} icon={icon} label={label} description={description} onOpen={()=>{}}/>)}</div></div></div></div></div>:<div className="fixture" style={{width}}><WorkspaceFileTree workspacePath="/workspace" workspaceName="project" onOpenPreview={()=>{}}/></div>};createRoot(document.getElementById('root')).render(<LucideProvider strokeWidth={1.5}><App/></LucideProvider>);`,
  zpi:
    common +
    `import {PaneLauncher} from ${JSON.stringify(resolve("packages/desktop/src/renderer/PaneLauncher.tsx"))};import {WorkspaceFileTree} from ${JSON.stringify(resolve("packages/desktop/src/renderer/workspace-file-tree/WorkspaceFileTree.tsx"))};window.zpi={getInstalledEditors:async()=>({ok:true,value:[]}),listTaskFiles:async()=>({ok:true,value:[]})};function App(){return <div className="fixture" style={{width}}>{kind==='launcher'?<PaneLauncher sessionId="fixture" sideChatAvailable={false} hasReview={false}/>:<WorkspaceFileTree sessionId="fixture" workspacePath="/workspace" workspaceName="project" onOpenPreview={()=>{}}/>}</div>};createRoot(document.getElementById('root')).render(<LucideProvider strokeWidth={1.5}><App/></LucideProvider>);`,
};
for (const name of ["ref", "zpi"]) {
  const entry = join(output, `${name}-entry.tsx`);
  await writeFile(entry, entries[name]);
  const plugin = {
    name: "header-dependencies",
    setup(build) {
      build.onResolve({ filter: /use-tree-data\.ts$|useWorkspaceFileTreeData\.js$/ }, () => ({
        path: "tree-data",
        namespace: "tree-mock",
      }));
      build.onResolve({ filter: /\/store\.ts$/ }, () => ({ path: "store", namespace: "tree-mock" }));
      build.onLoad({ filter: /.*/, namespace: "tree-mock" }, (args) => ({
        contents:
          args.path === "tree-data"
            ? `${fixtureData};export const useWorkspaceFileTreeData=()=>data;`
            : "export const report=()=>{},drafts={get:()=>null},focusComposer=()=>{};",
        loader: "js",
      }));
      build.onResolve({ filter: /^@zcode\/shared\/test-ids$/ }, () => ({
        path: "testids",
        namespace: "ref-extra",
      }));
      build.onLoad({ filter: /.*/, namespace: "ref-extra" }, () => ({
        contents:
          "export const TID_WORKSPACE_FILE_TREE_PANEL='tree',TID_WORKSPACE_FILE_TREE_REFRESH_BUTTON='refresh',TID_WORKSPACE_FILE_TREE_ROW='row',testId=(a,b)=>a+b;",
        loader: "js",
      }));
      build.onResolve({ filter: /pane-store\.ts$/ }, () => ({ path: "pane", namespace: "launcher-mock" }));
      build.onLoad({ filter: /.*/, namespace: "launcher-mock" }, () => ({
        contents:
          "export const openBrowser=()=>{},openChanges=()=>{},openFileManager=()=>{},openSideChat=()=>{},openTerminal=()=>{},paneTask=()=>{};",
        loader: "js",
      }));
      build.onResolve({ filter: /^@\// }, (args) => {
        const part = args.path.slice(2).replace(/\.js$/, "");
        const stubs = [
          "ControlHintTooltip",
          "i18n/IntlProvider",
          "hooks/usePlatform",
          "hooks/useWorkspaceOpenInEditorTarget",
          "workspace-file-tree/useInstalledFileTreeEditors",
          "workspace-file-tree/useWorkspaceFileSearchIndex",
          "hooks/useFileContextActions",
          "lib/workspaceEditorSelection",
          "logger",
          "components/ui/toast",
          "lib/workspaceFileDrag",
          "mentions/mentionMarkdown",
        ];
        return stubs.includes(part)
          ? { path: part, namespace: "header-stub" }
          : { path: join(ui, part + (existsSync(join(ui, `${part}.ts`)) ? ".ts" : ".tsx")) };
      });
      build.onLoad({ filter: /.*/, namespace: "header-stub" }, (args) => ({
        contents:
          args.path === "ControlHintTooltip"
            ? "export const SidebarNativeTooltip=({children})=>children,ControlHintTooltip=({children})=>children;"
            : args.path === "i18n/IntlProvider"
              ? `import messages from ${JSON.stringify(join(ui, "i18n/locales/zh-CN.ts"))};export const useZCodeIntl=()=>({intl:{formatMessage:({id})=>messages[id]??id}});`
              : args.path === "hooks/usePlatform"
                ? "export const usePlatform=()=>({});"
                : args.path === "hooks/useWorkspaceOpenInEditorTarget"
                  ? "export const useWorkspaceOpenInEditorTarget=()=>({});"
                  : args.path === "workspace-file-tree/useInstalledFileTreeEditors"
                    ? "export const useInstalledFileTreeEditors=()=>({installedEditors:[]});"
                    : args.path === "workspace-file-tree/useWorkspaceFileSearchIndex"
                      ? "export const useWorkspaceFileSearchIndex=()=>({entries:[],loaded:false,loading:false,refresh:()=>{}}),useWorkspaceFileSearchResults=()=>[];"
                      : args.path === "hooks/useFileContextActions"
                        ? "export const useFileContextActions=()=>({canRevealInFileManager:()=>false});"
                        : args.path === "lib/workspaceEditorSelection"
                          ? "export const resolveWorkspaceEditorSelection=()=>({availableEditors:[]}),resolveWorkspaceFileManagerEditor=()=>null;"
                          : args.path === "logger"
                            ? "export const logger={warn:()=>{},debug:()=>{},info:()=>{}};"
                            : args.path === "components/ui/toast"
                              ? "export const toast=()=>{};"
                              : args.path === "lib/workspaceFileDrag"
                                ? "export const WORKSPACE_FILE_DRAG_MIME='x',dispatchWorkspaceFileAddToChat=()=>{},dispatchWorkspaceFileDragState=()=>{},serializeWorkspaceFileDragPayload=()=>'';"
                                : "export const buildFileMentionMarkdown=()=>'';",
        loader: "tsx",
        resolveDir: root,
      }));
      build.onResolve({ filter: /^react(?:\/.*)?$|^react-dom(?:\/.*)?$/ }, (args) => ({
        path: ownRequire.resolve(args.path),
      }));
      build.onResolve({ filter: /^lucide-react$/ }, () => ({
        path: (name === "ref" ? refRequire : ownRequire).resolve("lucide-react"),
      }));
      build.onResolve(
        { filter: /^radix-ui$|^class-variance-authority$|^clsx$|^tailwind-merge$/ },
        (args) => ({ path: refRequire.resolve(args.path) }),
      );
      build.onResolve({ filter: /^zpi-ui$/ }, () => ({ path: "minimal", namespace: "zpi-minimal" }));
      build.onLoad({ filter: /.*/, namespace: "zpi-minimal" }, () => ({
        contents: `export {FileIcon} from ${JSON.stringify(resolve("packages/ui/src/components/Reference.tsx"))};export {ActionHint} from ${JSON.stringify(resolve("packages/ui/src/components/MessageActions.tsx"))};`,
        loader: "tsx",
        resolveDir: root,
      }));
    },
  };
  await bundle({
    entryPoints: [entry],
    bundle: true,
    format: "esm",
    platform: "browser",
    jsx: "automatic",
    outfile: join(output, `${name}.js`),
    plugins: [plugin],
    nodePaths: [join(root, "node_modules")],
    logLevel: "error",
  });
  const css = name === "ref" ? join(ui, "styles.css") : resolve("packages/ui/src/styles.css");
  const cssEntry = join(output, `${name}-style.css`);
  await writeFile(
    cssEntry,
    `@import ${JSON.stringify(css)};${name === "zpi" ? `@import ${JSON.stringify(resolve("packages/desktop/src/renderer/workbench.css"))};@import ${JSON.stringify(resolve("packages/desktop/src/renderer/workspace-file-tree/file-tree.css"))};` : ""}`,
  );
  await viteBuild({
    configFile: false,
    root: dirname(css),
    plugins: [tailwind()],
    build: { outDir: join(output, `${name}-css`), emptyOutDir: true, rollupOptions: { input: cssEntry } },
    logLevel: "error",
  });
  const assets = join(output, `${name}-css/assets`);
  const files = await readdir(assets);
  await writeFile(
    join(output, `${name}.css`),
    await readFile(
      join(
        assets,
        files.find((file) => file.endsWith(".css")),
      ),
      "utf8",
    ),
  );
}
const fixtureStyle = `html,body{margin:0!important;padding:0!important}body{background:var(--color-bg,var(--color-background));} .fixture{position:absolute;left:0;top:0;height:560px;background:var(--color-background);} .fixture button{transition:none!important;}`;
const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  try {
    if (url.pathname === "/") {
      const name = url.searchParams.get("app") === "zpi" ? "zpi" : "ref";
      res.setHeader("content-type", "text/html");
      res.end(
        `<html><head><link rel="stylesheet" href="/${name}.css"><style>${fixtureStyle}</style></head><body><div id="root"></div><script type="module" src="/${name}.js"></script></body></html>`,
      );
    } else {
      if (url.pathname.startsWith("/material-icons/")) {
        res.setHeader("content-type", "image/svg+xml");
        res.end(await readFile(join(root, "packages/desktop/src/renderer/public", url.pathname)));
        return;
      }
      const file = url.pathname.slice(1);
      if (!["ref.js", "zpi.js", "ref.css", "zpi.css"].includes(file)) {
        res.writeHead(404).end();
        return;
      }
      res.setHeader("content-type", file.endsWith("js") ? "text/javascript" : "text/css");
      res.end(await readFile(join(output, file)));
    }
  } catch (cause) {
    res.writeHead(500).end(String(cause));
  }
});
await safetyCheck();
const scope = await desktopScope();
let app;
const evidence = [];
try {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await bundle({
    stdin: {
      contents: `import {app} from 'electron';import {createDesktopWindow} from './packages/desktop/src/main/automation.ts';app.whenReady().then(()=>{const w=createDesktopWindow({width:800,height:600,useContentSize:true,webPreferences:{sandbox:true}});w.loadURL('http://127.0.0.1:${port}/');});`,
      resolveDir: root,
    },
    bundle: true,
    platform: "node",
    format: "cjs",
    external: ["electron"],
    outfile: join(output, "electron.cjs"),
    logLevel: "error",
  });
  const dir = await mkdtemp(join(tmpdir(), "zpi-file-manager-parity-"));
  app = await launchDesktop({ dir, url: "", entry: join(output, "electron.cjs") });
  const page = await app.firstWindow();
  page.on("pageerror", (error) => console.error(error.message));
  for (const kind of ["launcher", "tree"])
    for (const theme of ["light", "dark"])
      for (const width of kind === "launcher" ? [360, 600] : [192, 280])
        for (const size of [14, 20]) {
          const captures = [];
          const measurements = [];
          for (const name of ["ref", "zpi"]) {
            await page.goto(
              `http://127.0.0.1:${port}/?app=${name}&kind=${kind}&theme=${theme}&width=${width}&size=${size}`,
            );
            if (kind === "launcher") await page.locator('[data-side-pane-open-tab-item="files"]').waitFor();
            else await page.getByRole("treeitem").first().waitFor();
            await page.mouse.move(790, 580);
            await page.evaluate(() => document.fonts.ready);
            const path = join(output, `${kind}-${theme}-${width}-${size}-${name}.png`);
            await page.screenshot({
              path,
              clip: { x: 0, y: 0, width, height: 560 },
              animations: "disabled",
            });
            captures.push(path);
            measurements.push(
              await page
                .locator(
                  kind === "launcher"
                    ? "h2, [data-side-pane-open-tab-item], [data-side-pane-open-tab-item] > span"
                    : '[aria-label="搜索文件"], h3, [aria-label="更多"], [aria-label="仅显示变更文件"], [aria-label="刷新文件树"], [role="treeitem"], [aria-label="修改"]',
                )
                .evaluateAll((elements) =>
                  elements.map((element) => {
                    const r = element.getBoundingClientRect(),
                      s = getComputedStyle(element);
                    return {
                      label: element.ariaLabel ?? element.textContent,
                      x: r.x,
                      y: r.y,
                      width: r.width,
                      height: r.height,
                      font: s.font,
                      radius: s.borderRadius,
                      border: s.border,
                      shadow: s.boxShadow,
                      iconRects: [...element.querySelectorAll("svg")].map((svg) => {
                        const r = svg.getBoundingClientRect();
                        const style = getComputedStyle(svg);
                        return {
                          x: r.x,
                          y: r.y,
                          width: r.width,
                          height: r.height,
                          color: style.color,
                          strokeWidth: style.strokeWidth,
                          shapeRendering: style.shapeRendering,
                          transform: style.transform,
                        };
                      }),
                      color: s.color,
                      background: s.backgroundColor,
                      paths: [...element.querySelectorAll("svg")].map((svg) => svg.outerHTML),
                    };
                  }),
                ),
            );
          }
          const left = await sharp(captures[0]).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
          const right = await sharp(captures[1]).ensureAlpha().raw().toBuffer();
          let changed = 0;
          for (let i = 0; i < right.length; i += 4)
            if (Math.max(...[0, 1, 2].map((c) => Math.abs(left.data[i + c] - right[i + c]))) > 16) changed++;
          const comparison = join(output, `${kind}-${theme}-${width}-${size}-comparison.png`);
          await sharp({
            create: { width: left.info.width * 2, height: left.info.height, channels: 4, background: "#fff" },
          })
            .composite([
              { input: captures[0], left: 0, top: 0 },
              { input: captures[1], left: left.info.width, top: 0 },
            ])
            .png()
            .toFile(comparison);
          const geometryMatches = measurements[0].every((item, index) =>
            ["x", "y", "width", "height", "font"].every((key) => item[key] === measurements[1][index]?.[key]),
          );
          const svgPaths = (item) =>
            item.paths.map((svg) => svg.replace(/^<svg[^>]*>/, "").replace(/<\/svg>$/, "")).sort();
          const iconPathsMatch = measurements[0].every(
            (item, index) =>
              JSON.stringify(svgPaths(item)) === JSON.stringify(svgPaths(measurements[1][index])),
          );

          if (!geometryMatches || !iconPathsMatch)
            throw new Error(`Visual parity mismatch: ${theme}/${width}/${size}`);
          evidence.push({
            kind,
            geometryMatches,
            iconPathsMatch,
            theme,
            width,
            size,
            changedPixels: changed,
            totalPixels: left.info.width * left.info.height,
            measurements,
            comparison,
          });
        }
  await writeFile(join(output, "evidence.json"), JSON.stringify({ sourceCommit, evidence }, null, 2));
  console.log(
    JSON.stringify(
      {
        sourceCommit,
        output,
        results: evidence.map(({ kind, theme, width, size, changedPixels, totalPixels }) => ({
          kind,
          theme,
          width,
          size,
          changedPixels,
          totalPixels,
        })),
      },
      null,
      2,
    ),
  );
} finally {
  await app?.close();
  await scope.close();
  await new Promise((resolve) => server.close(resolve));
}
