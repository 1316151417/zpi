// Render the checked-out ZCode header and ZPI header with their own styles and icons.
// node scripts/verify-task-list-parity.mjs /path/to/ZCode
import { execFileSync } from "node:child_process";
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
const output = resolve("release/task-list-parity");
await mkdir(output, { recursive: true });
const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: reference, encoding: "utf8" }).trim();
const ownRequire = createRequire(join(root, "package.json"));
const refRequire = createRequire(join(reference, "package.json"));
const common = `import React,{useState} from 'react';import {createRoot} from 'react-dom/client';import {LucideProvider} from 'lucide-react';
const params=new URLSearchParams(location.search);const theme=params.get('theme')??'light';const width=Number(params.get('width')??280);const size=Number(params.get('size')??14);
document.documentElement.className=theme==='dark'?'dark theme-zai-dark':'theme-zai-light';document.documentElement.dataset.theme=theme;document.documentElement.style.colorScheme=theme;document.body.style.background=theme==='dark'?'#161616':'#f0f0f0';document.documentElement.style.setProperty('--ui-font-size',size+'px');document.documentElement.style.setProperty('--ui-font-size-sm',(size-2)+'px');
`;
const entries = {
  ref:
    common +
    `import {ProjectSidebarListHeader} from ${JSON.stringify(join(ui, "project-sidebar/ProjectSidebarListHeader.tsx"))};
function App(){const [view,setView]=useState('projects');return <div className="fixture bg-sidebar" style={{width}}><ProjectSidebarListHeader view={view} onViewChange={setView} onOpenCommandCenter={()=>{}}/></div>};createRoot(document.getElementById('root')).render(<LucideProvider strokeWidth={1.5}><App/></LucideProvider>);`,
  zpi:
    common +
    `import {TaskListHeader} from ${JSON.stringify(resolve("packages/desktop/src/renderer/TaskListHeader.tsx"))};
function App(){const [value,onChange]=useState({organizeBy:'project'});return <div className="fixture sidebar" style={{width}}><TaskListHeader value={value} onChange={onChange} onSearch={()=>{}}/></div>};createRoot(document.getElementById('root')).render(<LucideProvider strokeWidth={1.5}><App/></LucideProvider>);`,
};
for (const name of ["ref", "zpi"]) {
  const entry = join(output, `${name}-entry.tsx`);
  await writeFile(entry, entries[name]);
  const plugin = {
    name: "header-dependencies",
    setup(build) {
      build.onResolve({ filter: /^@\// }, (args) => {
        const part = args.path.slice(2).replace(/\.js$/, "");
        if (["components/ui/button", "components/ui/dropdown-menu", "components/lib/utils"].includes(part))
          return { path: join(ui, part + (part.endsWith("utils") ? ".ts" : ".tsx")) };
        return { path: part, namespace: "header-stub" };
      });
      build.onLoad({ filter: /.*/, namespace: "header-stub" }, (args) => ({
        contents:
          args.path === "ControlHintTooltip"
            ? "export const ControlHintTooltip=({children})=>children;"
            : args.path === "i18n/IntlProvider"
              ? `import messages from ${JSON.stringify(join(ui, "i18n/locales/zh-CN.ts"))};export const useZCodeIntl=()=>({intl:{formatMessage:({id})=>messages[id]??id}});`
              : args.path === "lib/keyboardShortcuts"
                ? "export const formatCommandShortcutLabel=()=>'';"
                : "",
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
        contents: `export {ActionHint} from ${JSON.stringify(resolve("packages/ui/src/components/MessageActions.tsx"))};`,
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
    `@import ${JSON.stringify(css)};${name === "zpi" ? `@import ${JSON.stringify(resolve("packages/desktop/src/renderer/workbench.css"))};` : ""}`,
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
const fixtureStyle = `html,body{margin:0!important;padding:0!important}body{background:var(--color-bg,var(--color-background));} .fixture{position:absolute!important;left:40px!important;top:40px!important;height:260px!important;padding:12px 0 0!important;border:0!important;background:var(--color-sidebar,var(--sidebar))!important;display:block!important;overflow:visible!important;transition:none!important;} .fixture button{transition:none!important;} .fixture.sidebar{--left-sidebar-width:280px;}`;
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
      contents: `import {app} from 'electron';import {createDesktopWindow} from './packages/desktop/src/main/automation.ts';app.whenReady().then(()=>{const w=createDesktopWindow({width:640,height:480,useContentSize:true,webPreferences:{sandbox:true}});w.loadURL('http://127.0.0.1:${port}/');});`,
      resolveDir: root,
    },
    bundle: true,
    platform: "node",
    format: "cjs",
    external: ["electron"],
    outfile: join(output, "electron.cjs"),
    logLevel: "error",
  });
  const dir = await mkdtemp(join(tmpdir(), "zpi-header-parity-"));
  app = await launchDesktop({ dir, url: "", entry: join(output, "electron.cjs") });
  const page = await app.firstWindow();
  page.on("pageerror", (error) => console.error(error.message));
  for (const theme of ["light", "dark"])
    for (const width of [200, 280, 360])
      for (const size of [14, 20]) {
        const captures = [];
        const measurements = [];
        for (const name of ["ref", "zpi"]) {
          await page.goto(`http://127.0.0.1:${port}/?app=${name}&theme=${theme}&width=${width}&size=${size}`);
          await page.getByTestId("sidebar-list-title").waitFor();
          await page.getByTestId("sidebar-view-menu").click();
          await page.getByRole("menuitemradio", { name: "最近更新", exact: true }).waitFor();
          await page.mouse.move(600, 420);
          await page.evaluate(() => document.fonts.ready);
          const path = join(output, `${theme}-${width}-${size}-${name}.png`);
          await page.screenshot({
            path,
            clip: { x: 32, y: 32, width: width + 16, height: 250 },
            animations: "disabled",
          });
          captures.push(path);
          measurements.push(
            await page
              .locator(
                '[data-testid="sidebar-list-title"], [data-testid="sidebar-search-open"], [data-testid="sidebar-view-menu"], [role="menu"], [role="menuitemradio"]',
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
        const comparison = join(output, `${theme}-${width}-${size}-comparison.png`);
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
          throw new Error(`Header parity mismatch: ${theme}/${width}/${size}`);
        evidence.push({
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
        results: evidence.map(({ theme, width, size, changedPixels, totalPixels }) => ({
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
