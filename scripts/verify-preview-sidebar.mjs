// Component-level visual comparison against the untouched, checked-out ZCode sources.
// Run: node scripts/verify-preview-sidebar.mjs [reference repository]
import { execFileSync } from "node:child_process";
import { copyFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { _electron as electron } from "@playwright/test";
import tailwind from "@tailwindcss/vite";
import { build as bundle } from "esbuild";
import sharp from "sharp";
import { build as viteBuild } from "vite";

const root = process.cwd();
const reference = resolve(process.argv[2] ?? "/Users/jiezhou/VSCodeProjects/ZCode");
const refUI = join(reference, "packages/ui/src");
const output = resolve("release/preview-sidebar-parity");
await mkdir(output, { recursive: true });
const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: reference, encoding: "utf8" }).trim();
const requireRef = createRequire(join(reference, "package.json"));
const now = Date.parse("2026-10-08T12:00:00+08:00");
const read = (path) => readFile(path, "utf8");
const messagesFile = join(refUI, "i18n/locales/zh-CN.ts");
const common = `import React,{useState} from "react";import {LucideProvider} from "lucide-react";import {createRoot} from "react-dom/client";
import messages from ${JSON.stringify(messagesFile)};
const intl={formatMessage:({id},values={})=>(messages[id]??id).replace(/\\{(\\w+)\\}/g,(_,k)=>values[k]??k)};
Date.now=()=>${now};
const noop=()=>{};
const services={load:async()=>[],openFile:async()=>{},openWebsite:async()=>{},openExternal:async()=>{},fileAction:async()=>{}};
const cards=[
 {id:"web",type:"website",title:"动态页面",subtitleId:"chat.previewCards.website",url:"http://localhost:5173/preview"},
 {id:"md",type:"markdown",kind:"markdown",title:"项目实施报告.md",subtitleId:"chat.previewCards.markdown",path:"/workspace/项目实施报告.md"},
 {id:"pdf",type:"file",kind:"pdf",title:"分析文档.pdf",subtitleId:"chat.previewCards.pdf",path:"/workspace/分析文档.pdf"},
 {id:"xlsx",type:"file",kind:"xlsx",title:"业务报表.xlsx",subtitleId:"chat.previewCards.xlsx",path:"/workspace/业务报表.xlsx"},
 {id:"pptx",type:"file",kind:"pptx",title:"项目汇报.pptx",subtitleId:"chat.previewCards.pptx",path:"/workspace/项目汇报.pptx"}
];
const tasks=Array.from({length:5},(_,i)=>({id:String(i),taskId:String(i),title:i===1?"这是一条用于验证窄侧栏渐隐效果的很长任务标题":['实现自动预览卡片','', '检查项目分页规则','补充桌面交互测试','整理验收证据'][i],workspacePath:'/workspace/zpi',cwd:'/workspace/zpi',createdAt:${now}-i*86400000,updatedAt:${now}-[30000,5*60000,3*3600000,86400000,2*86400000][i],status:'completed',projectId:'zpi',path:'',unreadAt:i===2?${now}:undefined}));
const mode=new URLSearchParams(location.search).get('mode')??'cards';
if(mode==='tasks-page')tasks.push(...Array.from({length:16},(_,i)=>({...tasks[i%5],id:String(i+5),taskId:String(i+5)})));
const theme=new URLSearchParams(location.search).get('theme')??'light';
document.documentElement.className=theme==='dark'?'dark theme-zai-dark':'theme-zai-light';document.documentElement.dataset.theme=theme;
`;
const originalMenuSource = await read(join(refUI, "WorkspaceSidebar.tsx"));
const menuStart = originalMenuSource.indexOf(
  "<DropdownMenu>",
  originalMenuSource.indexOf("{showTaskViewFilter ? ("),
);
const menuEnd = originalMenuSource.indexOf("</DropdownMenu>", menuStart) + "</DropdownMenu>".length;
const originalMenu = originalMenuSource.slice(menuStart, menuEnd);
const refEntry =
  common +
  `
import {AssistantPreviewCards} from ${JSON.stringify(join(refUI, "AssistantPreviewCards.tsx"))};
import {MemoTaskItem} from ${JSON.stringify(join(refUI, "TaskListItem.tsx"))};
import {groupTaskTimelineItems,getTaskTimelineGroupMessage} from ${JSON.stringify(join(refUI, "lib/taskTimelineGroups.ts"))};
import {Button} from ${JSON.stringify(join(refUI, "components/ui/button.tsx"))};
import {ControlHintTooltip} from '@/ControlHintTooltip.js';
import {DropdownMenu,DropdownMenuTrigger,DropdownMenuContent,DropdownMenuLabel,DropdownMenuRadioGroup,DropdownMenuRadioItem,DropdownMenuSeparator} from '@/components/ui/dropdown-menu.js';
import {Folder,Clock3,ListFilter,MessageCircleCheck,MessageCirclePlus} from 'lucide-react';
function Filter(){const [workspaceTaskViewValue,handleWorkspaceTaskViewChange]=useState('project');const [taskSortBy,setTaskSortBy]=useState('updated');const showWorkspaceViewOptions=true,showTaskSortOptions=true;return ${originalMenu};}
function Rows({timeline=false,items=tasks}){return <ul className="space-y-0.5">{items.map((task,i)=><MemoTaskItem key={task.id} workspacePath="/workspace/zpi" task={task} variant={timeline?'timeline':'default'} isPinned={false} isActive={task.id==='0'} intl={intl} onSelectTask={noop} onArchiveTaskInline={noop} onCancelArchiveConfirm={noop} isArchiveConfirming={false} onTogglePinTask={noop} onStartRenameTask={noop} onArchiveTask={noop} onMarkTaskAsUnread={noop}/>)}</ul>}
function App(){return <div className="fixture">
{mode==='cards'||mode==='open-menu'?<div className="card-frame"><p>已完成以下文件，可以直接打开预览。</p><div style={{marginTop:12}}><AssistantPreviewCards cards={cards} workspacePath="/workspace" onOpenBrowserUrl={noop} onOpenCodeViewer={noop}/></div></div>:
mode==='sort-menu'?<div className="menu-frame"><Filter/></div>:
<div className="sidebar-frame">{mode==='timeline'?<ul className="space-y-1">{groupTaskTimelineItems(tasks,{sortBy:'updated',now:Date.now(),locale:'zh-CN'}).map(group=><li key={group.key} className="space-y-0.5"><div className="px-3 pt-2 pb-1 text-ui-base font-medium text-foreground-subtle">{intl.formatMessage(getTaskTimelineGroupMessage(group.label),getTaskTimelineGroupMessage(group.label).values)}</div><Rows timeline items={group.items}/></li>)}</ul>:<>{mode==='projects'?<div className="flex h-8 items-center gap-2 rounded-lg pl-2.5 pr-1 text-ui-base"><Folder size={14}/><span>zpi</span></div>:null}<div style={{marginTop:mode==='projects'?4:0}}><Rows items={tasks.slice(0,20)}/></div></>}{(mode==='projects'||mode==='tasks-page')&&<div className="cursor-pointer pl-8.5" style={{paddingBottom:mode==='projects'?0:16}}><button className="text-ui-base text-foreground-subtlest hover:text-foreground-subtle">显示更多</button></div>}</div>}
</div>};createRoot(document.getElementById('root')).render(<LucideProvider strokeWidth={1.5}><App/></LucideProvider>);`;
const zpiEntry =
  common +
  `
import {AssistantPreviewCardRow} from ${JSON.stringify(resolve("packages/ui/src/components/AssistantPreviewCards.tsx"))};
import {SidebarTaskRow} from ${JSON.stringify(resolve("packages/desktop/src/renderer/SidebarTaskRow.tsx"))};
import {TaskViewMenu} from ${JSON.stringify(resolve("packages/desktop/src/renderer/TaskViewMenu.tsx"))};
import {SidebarTaskList} from ${JSON.stringify(resolve("packages/desktop/src/renderer/SidebarTaskList.tsx"))};
import {Folder} from 'lucide-react';
function Filter(){const [value,onChange]=useState({organizeBy:'project',sortBy:'updated'});return <TaskViewMenu value={value} onChange={onChange}/>}
function Rows({timeline=false}){return <div className="task-list-rows">{tasks.map((record,i)=><SidebarTaskRow key={record.id} record={record} active={i===0} workspace="zpi" variant={timeline?'timeline':'default'} pinLimitReached={false} onSelect={noop} onPin={noop} onArchive={noop}/>)}</div>}
function App(){return <div className="fixture">
{mode==='cards'||mode==='open-menu'?<div className="card-frame"><p>已完成以下文件，可以直接打开预览。</p><div className="assistant-preview-cards">{cards.map((card,index)=><AssistantPreviewCardRow key={card.id} card={card} index={index} sessionId="fixture" services={services}/>)}</div></div>:
mode==='sort-menu'?<div className="menu-frame sidebar"><Filter/></div>:
<div className="sidebar-frame sidebar">{mode==='timeline'||mode==='tasks-page'?<SidebarTaskList tasks={tasks} sortBy='updated' timeline={mode==='timeline'} renderRow={(record,variant)=><SidebarTaskRow key={record.id} record={record} active={record.id==='0'} workspace='zpi' variant={variant} pinLimitReached={false} onSelect={noop} onPin={noop} onArchive={noop}/>}/>:<>{mode==='projects'?<div className="project-title"><Folder size={14}/><span>zpi</span></div>:null}<div style={{marginTop:mode==='projects'?4:0}}><Rows/></div></>}{mode==='projects'&&<div className='task-show-more'><button>显示更多</button></div>}</div>}
</div>};createRoot(document.getElementById('root')).render(<LucideProvider strokeWidth={1.5}><App/></LucideProvider>);`;
await writeFile(join(output, "ref-entry.tsx"), refEntry);
await writeFile(join(output, "zpi-entry.tsx"), zpiEntry);
const actual = new Set([
  "AssistantPreviewCards",
  "TaskListItem",
  "OpenSplitButton",
  "components/TaskTitleOverflowText",
  "components/ui/button",
  "components/ui/badge",
  "components/ui/dropdown-menu",
  "components/lib/utils",
  "lib/fileDisplay",
  "lib/fileDisplayHelpers",
  "lib/path",
  "lib/assistantPreviewCards",
  "lib/assistantFileReferences",
  "lib/assistantPreviewCardValidation",
  "lib/assistantPathQuotes",
  "lib/markdownFileLink",
  "lib/mediaPreview",
  "lib/taskListItemPresentation",
  "lib/taskChangeSummary",
  "v4/taskListRowActivity",
  "lib/editorPreference",
  "lib/workspaceEditorSelection",
  "lib/openWithEditors",
  "workspace-grouped-tasks/task-row-action-button",
]);
const exportsForStub = new Map();
const special = {
  useWorkspaceServices: "()=>({fileService:globalThis.__fileService})",
  useZCodeIntl: "()=>({intl:globalThis.__intl})",
  usePlatform: "()=>({getInstalledEditors:async()=>globalThis.__apps})",
  useWorkspaceOpenInEditorTarget: "()=>({isRemoteWorkspace:false})",
  useOptionalTabStore: "()=>false",
  useV4SplitPaneEntry: "()=>({enabled:false})",
  useWorkbenchGroupStore: "()=>false",
  getTaskListAttention: "()=>null",
  ControlHintTooltip: "({children})=>children",
  logger: "{warn:()=>{}}",
  runUserAction: "({operation})=>operation()",
  testId: '(...parts)=>parts.join(":")',
};
const prelude = `import messages from ${JSON.stringify(messagesFile)};globalThis.__intl={formatMessage:({id},values={})=>(messages[id]??id).replace(/\\{(\\w+)\\}/g,(_,k)=>values[k]??k)};globalThis.__apps=[{id:'finder',name:'Finder',iconDataUrl:'/file-actions/finder.png'}];globalThis.__fileService={checkFilesExist:async({paths})=>paths.map(path=>({path,exists:true}))};`;
await writeFile(join(output, "prelude.ts"), prelude);
let bundlingName = "ref";
const plugin = {
  name: "reference-adapters",
  setup(build) {
    build.onResolve({ filter: /^@\/|^@zcode\// }, async (args) => {
      const part = args.path.startsWith("@/") ? args.path.slice(2).replace(/\.js$/, "") : null;
      if (part && actual.has(part)) {
        for (const ext of [".tsx", ".ts"]) {
          try {
            const path = join(refUI, part + ext);
            await read(path);
            return { path };
          } catch {}
        }
      }
      if (args.path === "@zcode/shared/conversation-preview-artifacts")
        return { path: join(reference, "packages/shared/src/conversation-preview-artifacts.ts") };
      const importer = await read(args.importer);
      const stubKey = `${args.path}::${args.importer}`;
      const names = exportsForStub.get(stubKey) ?? new Set();
      for (const m of importer.matchAll(/import\s+(?:type\s+)?\{([^}]+)\}\s+from\s+["']([^"']+)["']/g))
        if (m[2] === args.path)
          for (const name of m[1].split(",")) {
            const clean = name
              .trim()
              .replace(/^type\s+/, "")
              .split(/\s+as\s+/)[0]
              .trim();
            if (clean) names.add(clean);
          }
      exportsForStub.set(stubKey, names);
      return { path: stubKey, namespace: "stub" };
    });
    build.onLoad({ filter: /.*/, namespace: "stub" }, (args) => ({
      contents: [...(exportsForStub.get(args.path) ?? [])]
        .map((name) =>
          [
            "buildConversationPreviewArtifactCandidatesFromReferences",
            "CONVERSATION_PREVIEW_CARD_CANDIDATE_LIMIT",
            "CONVERSATION_PREVIEW_CARD_VISIBLE_LIMIT",
            "extractConversationPreviewFileReferences",
          ].includes(name)
            ? `export {${name}} from ${JSON.stringify(join(reference, "packages/shared/src/conversation-preview-artifacts.ts"))};`
            : name === "MEDIA_PREVIEW_FORMATS"
              ? `export {MEDIA_PREVIEW_FORMATS} from ${JSON.stringify(join(reference, "packages/shared/src/media-preview.ts"))};`
              : `export const ${name}=${special[name] ?? "()=>null"};`,
        )
        .join("\n"),
      loader: "tsx",
      resolveDir: root,
    }));
    build.onResolve({ filter: /^radix-ui$|^class-variance-authority$|^clsx$|^tailwind-merge$/ }, (args) => ({
      path: requireRef.resolve(args.path),
    }));
    build.onResolve({ filter: /^lucide-react$/ }, () => ({
      path: (bundlingName === "ref" ? requireRef : createRequire(join(root, "package.json"))).resolve(
        "lucide-react",
      ),
    }));
    build.onResolve({ filter: /^react(?:\/.*)?$|^react-dom(?:\/.*)?$/ }, (args) => ({
      path: createRequire(join(root, "package.json")).resolve(args.path),
    }));
    build.onResolve({ filter: /^ZPI-ui$/ }, () => ({ path: "zpi-minimal", namespace: "minimal" }));
    build.onLoad({ filter: /.*/, namespace: "minimal" }, () => ({
      contents: `export {TaskTitleOverflowText} from ${JSON.stringify(resolve("packages/ui/src/components/TaskTitleOverflowText.tsx"))};export {ActionHint} from ${JSON.stringify(resolve("packages/ui/src/components/MessageActions.tsx"))};`,
      loader: "tsx",
      resolveDir: root,
    }));
  },
};
for (const name of ["ref", "zpi"]) {
  bundlingName = name;
  await bundle({
    entryPoints: [join(output, `${name}-entry.tsx`)],
    bundle: true,
    format: "esm",
    platform: "browser",
    jsx: "automatic",
    outfile: join(output, `${name}.js`),
    plugins: [plugin],
    nodePaths: [join(root, "node_modules"), join(reference, "node_modules")],
    inject: name === "ref" ? [join(output, "prelude.ts")] : [],
    define: { "import.meta.env.BASE_URL": '"/"' },
    logLevel: "error",
  });
}
for (const [name, css] of [
  ["ref", join(refUI, "styles.css")],
  ["zpi", resolve("packages/ui/src/styles.css")],
]) {
  const entry = join(output, `${name}-style.css`);
  await writeFile(
    entry,
    `@import ${JSON.stringify(css)};${name === "zpi" ? `@import ${JSON.stringify(resolve("packages/desktop/src/renderer/workbench.css"))};` : ""}`,
  );
  await viteBuild({
    configFile: false,
    root: dirname(css),
    plugins: [tailwind()],
    build: { outDir: join(output, `${name}-css`), emptyOutDir: true, rollupOptions: { input: entry } },
    logLevel: "error",
  });
  const files = await readdir(join(output, `${name}-css/assets`));
  await writeFile(
    join(output, `${name}.css`),
    await read(
      join(
        output,
        `${name}-css/assets`,
        files.find((f) => f.endsWith(".css")),
      ),
    ),
  );
}
const fixtureCSS = `.fixture{width:1200px;height:800px;background:var(--color-bg,var(--color-background));color:var(--color-foreground);font:14px/1.5 ui-sans-serif,system-ui,sans-serif;padding:80px;} .card-frame{width:640px;margin:auto;} .card-frame>p{margin:0;} .sidebar-frame{width:280px;} .fixture .sidebar{position:static;width:280px;padding:0;display:block;background:transparent;border:0;} .menu-frame{width:280px;display:flex!important;flex-direction:row!important;justify-content:flex-end;} .fixture .sidebar-frame .project-title{display:flex;align-items:center;} .fixture button{cursor:pointer;}`;
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname === "/") {
      const name = url.searchParams.get("app") ?? "ref";
      res.setHeader("content-type", "text/html");
      res.end(
        `<html lang="en"><head><link rel="stylesheet" href="/${name}.css"><style>${fixtureCSS}</style></head><body><div id="root"></div><script type="module" src="/${name}.js"></script></body></html>`,
      );
      return;
    }
    const path =
      url.pathname.startsWith("/material-icons/") || url.pathname.startsWith("/file-actions/")
        ? join(root, "packages/desktop/src/renderer/public", url.pathname)
        : join(output, url.pathname);
    const ext = path.split(".").at(-1);
    res.setHeader(
      "content-type",
      { js: "text/javascript", css: "text/css", svg: "image/svg+xml", png: "image/png" }[ext] ??
        "application/octet-stream",
    );
    res.end(await readFile(path));
  } catch (error) {
    res.statusCode = 404;
    res.end(String(error));
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;
await writeFile(
  join(output, "electron.cjs"),
  `const {app,BrowserWindow}=require('electron');app.whenReady().then(()=>{const w=new BrowserWindow({width:1200,height:800,useContentSize:true,webPreferences:{sandbox:true}});w.loadURL('http://127.0.0.1:${port}/');});`,
);
const app = await electron.launch({
  args: [join(output, "electron.cjs")],
  env: { ...process.env, ELECTRON_RUN_AS_NODE: "" },
});
const evidence = [];
try {
  const page = await app.firstWindow();
  page.on("pageerror", (error) => console.error("Fixture:", error.message));
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.addInitScript(() => {
    const real = window.matchMedia.bind(window);
    window.matchMedia = (query) => {
      const value = real(query);
      if (query === "(hover: none)" && location.search.includes("tasks-touch"))
        Object.defineProperty(value, "matches", { value: true });
      return value;
    };
  });
  for (const theme of ["light", "dark"])
    for (const mode of [
      "cards",
      "open-menu",
      "sort-menu",
      "projects",
      "tasks",
      "timeline",
      "tasks-hover",
      "tasks-focus",
      "tasks-touch",
      "tasks-narrow",
      "tasks-page",
    ]) {
      const captures = [];
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
      for (const name of ["ref", "zpi"]) {
        await page.goto(`http://127.0.0.1:${port}/?app=${name}&mode=${mode}&theme=${theme}`);
        await page.locator(".fixture").waitFor();
        if (mode === "cards" || mode === "open-menu")
          await page
            .locator(name === "ref" ? "[data-zcode-stream-animate]" : ".assistant-preview-card")
            .first()
            .waitFor();
        if (mode === "open-menu") {
          await page
            .getByLabel(/选择打开/)
            .nth(1)
            .click();
          await page.getByRole("menuitem").filter({ hasText: "Finder" }).waitFor();
        }
        if (mode === "sort-menu") {
          await page.getByLabel("筛选和排序", { exact: true }).click();
          await page.getByRole("menuitemradio", { name: "创建时间" }).waitFor();
        }
        await page.evaluate(async () => {
          await document.fonts.ready;
          await Promise.all([...document.images].map((img) => img.decode().catch(() => {})));
        });
        await page.mouse.move(1150, 750);
        if (mode === "tasks-narrow")
          await page.locator(".sidebar-frame").evaluate((el) => {
            el.style.width = "180px";
          });
        if (mode === "tasks-hover") await page.locator("[data-task-item-key]").nth(1).hover();
        if (mode === "tasks-focus") await page.locator("[data-task-item-key]").nth(1).focus();
        const path = join(output, `${mode}-${theme}-${name}.png`);
        await page.screenshot({ path, animations: "disabled" });
        captures.push(path);
        const measurements = await page
          .locator(
            mode === "cards"
              ? name === "ref"
                ? "[data-zcode-stream-animate]"
                : ".assistant-preview-card"
              : mode === "sort-menu" || mode === "open-menu"
                ? '[role="menu"], [aria-expanded="true"]'
                : ".sidebar-frame",
          )
          .evaluateAll((els) =>
            els.map((el) => {
              const r = el.getBoundingClientRect(),
                s = getComputedStyle(el);
              return {
                x: r.x,
                y: r.y,
                width: r.width,
                height: r.height,
                font: s.font,
                color: s.color,
                background: s.backgroundColor,
              };
            }),
          );
        const parts = await page.locator('.fixture svg, [role="menu"] svg').evaluateAll((els) =>
          els.map((el) => {
            const r = el.getBoundingClientRect(),
              s = getComputedStyle(el);
            return {
              x: r.x,
              y: r.y,
              width: r.width,
              height: r.height,
              color: s.color,
              strokeWidth: s.strokeWidth,
              paths: el.innerHTML,
            };
          }),
        );
        evidence.push({ mode, theme, app: name, measurements, parts });
      }
      const left = await sharp(captures[0]).ensureAlpha().raw().toBuffer({ resolveWithObject: true }),
        right = await sharp(captures[1]).ensureAlpha().raw().toBuffer();
      let changed = 0;
      for (let i = 0; i < right.length; i += 4)
        if (Math.max(...[0, 1, 2].map((c) => Math.abs(left.data[i + c] - right[i + c]))) > 16) changed++;
      const width = left.info.width,
        height = left.info.height;
      await sharp({ create: { width: width * 2, height, channels: 4, background: "#fff" } })
        .composite([
          { input: captures[0], left: 0, top: 0 },
          { input: captures[1], left: width, top: 0 },
        ])
        .png()
        .toFile(join(output, `${mode}-${theme}-comparison.png`));
      const overlay = await sharp(captures[1]).ensureAlpha(0.5).toBuffer();
      await sharp(captures[0])
        .composite([{ input: overlay }])
        .png()
        .toFile(join(output, `${mode}-${theme}-overlay.png`));
      evidence.push({ mode, theme, changedPixels: changed, totalPixels: width * height });
      console.log(`${mode} ${theme}: ${changed} pixels differ >16/255`);
    }
  await writeFile(
    join(output, "evidence.json"),
    JSON.stringify(
      {
        reference,
        sha,
        clock: now,
        viewport: [1200, 800],
        sidebar: 280,
        font: 14,
        zoom: 1,
        method:
          "Original reference card/task/dropdown components; injected deterministic services and state. Project/timeline shells use source class lists. Not a full ZCode application screenshot.",
        evidence,
      },
      null,
      2,
    ),
  );
} finally {
  await app.close();
  await new Promise((r) => server.close(r));
}
const evidenceDir = resolve("docs/evidence/preview-sidebar");
await mkdir(evidenceDir, { recursive: true });
for (const file of await readdir(output))
  if (/-(?:comparison|overlay|ref|zpi)\.png$/.test(file) || file === "evidence.json")
    await copyFile(join(output, file), join(evidenceDir, file));
execFileSync(resolve("node_modules/.bin/biome"), ["format", "--write", join(evidenceDir, "evidence.json")]);
console.log(evidenceDir);
