import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import { build, type InlineConfig, preview } from "vite";
import { launchDesktop } from "../helpers/desktop.ts";
import { expect, test } from "../helpers/test.ts";

test("compare actual ZCode and ZPI review components using identical snapshots", async ({
  desktopIsolation,
}, info) => {
  void desktopIsolation;
  const referenceRepo = process.env.ZPI_ZCODE_REFERENCE;
  if (!referenceRepo) {
    test.skip(true, "Set ZPI_ZCODE_REFERENCE to compare a local ZCode checkout");
    return;
  }
  test.setTimeout(90000);
  const dir = await mkdtemp(join(tmpdir(), "zpi-reference-"));
  const site = join(dir, "site");
  await mkdir(site);
  const root = resolve(".");
  const reference = resolve(referenceRepo, "packages/ui/src");
  const evidence = process.env.ZPI_REVIEW_EVIDENCE_DIR ?? info.outputPath("comparison");
  await mkdir(evidence, { recursive: true });
  const original = `${Array.from({ length: 120 }, (_, i) => `import com.ke.home.performance.Line${String(i + 1).padStart(3, "0")};`).join("\n")}\n`;
  const diff = {
    path: "/project/src/ResetTest.java",
    availability: "patch",
    beforeContent: original,
    afterContent: original
      .replace("Line019", "Changed019")
      .replace("Line041", "Changed041")
      .replace("Line063", "Changed063"),
    patch:
      "--- a/src/ResetTest.java\n+++ b/src/ResetTest.java\n@@ -19 +19 @@\n-import com.ke.home.performance.Line019;\n+import com.ke.home.performance.Changed019;\n",
    summary: null,
  };
  await writeFile(
    join(site, "index.html"),
    '<div id="root"></div><script type="module" src="/main.tsx"></script>',
  );
  await writeFile(
    join(site, "stub.ts"),
    `
    export const data = ${JSON.stringify(diff)};
    export const settings = { theme: "light", codePreviewSettings: {lightTheme:"github-light",darkTheme:"github-dark",fontSizePx:12,showLineNumbers:true,wrapLongLines:false} };
    export const useZCodeStore = (selector:any) => selector(settings);
    export const useStore = (selector:any) => selector({settings:{interface:{codePreview:settings.codePreviewSettings}}});
    export const useWorkspace = () => ({cwd:"/project"});
    export const getWorkspaceFileRelativePath = (root:string,path:string)=>path.slice(root.length+1);
    export const useServices = () => ({gitService:{getDiff: async()=>data}});
    export const useFileContextActions = () => ({canRevealInFileManager:()=>true});
    export const useWorkspaceOpenInEditorTarget = () => ({isRemoteWorkspace:false});
    export const resolveTheme = () => document.documentElement.dataset.theme;
    export const logger = {debug:()=>{},info:()=>{},warn:()=>{}};
    export const report = ()=>{};
    export const openFileManager = ()=>{};
    export const paneTask = ()=>{};
    const copy:any = {"common.loading":"加载中...","git.changeContext.revealInFileManager":"在文件管理器中打开", "git.changeContext.revealInFileTree":"在文件树中显示", "fileActions.copyAbsolutePath":"复制绝对路径","fileActions.copyRelativePath":"复制相对路径", "git.source.unstaged":"未暂存","git.source.staged":"已暂存","git.source.branch":"全部分支更改","git.source.lastTurn":"上一轮更改","git.action.refresh":"刷新"};
    export const useZCodeIntl = () => ({intl:{formatMessage:({id}:any)=>copy[id]??id}});
  `,
  );
  await writeFile(
    join(site, "shim.ts"),
    `
    export { FileIcon } from "${root}/packages/ui/src/components/Reference.tsx";
    export { ReviewDiffViewer } from "${root}/packages/ui/src/components/ReviewDiffViewer.tsx";
    export { defaultCodePreview } from "${root}/packages/ui/src/code-preview.ts";
    export { reviewFindTargets } from "${root}/packages/ui/src/review-find.ts";
    export const useTextFind = ()=>{};
  `,
  );
  await writeFile(
    join(site, "reference.tsx"),
    `
    import {useState} from "react";
    import {GitPane} from "${reference}/GitPane.tsx";
    import "${reference}/styles.css";
    import {data} from "./stub.ts";
    export function Panel(){
      const [source,setSource]=useState("unstaged");
      const change={path:data.path,workspaceRelativePath:"src/ResetTest.java",kind:"modified",added:3,removed:3,section:"unstaged"};
      const dataset={id:"unstaged",sections:[{id:"unstaged",changes:[change]}]};
      return <GitPane workspacePath="/project" isDesktop selectedSourceId={source} gitState={{revision:1,loading:false,error:null,summary:{isRepository:true,isGitAvailable:true},sourceOptions:[{id:"unstaged"},{id:"staged"},{id:"branch"},{id:"last-turn"}],datasets:{unstaged:dataset}} as any} fileChangeFindActiveIndex={-1} fileChangeFindNavigationRequestId={0} fileChangeFindQuery="" onFileChangeFindMatchCountChange={()=>{}} onSelectSource={setSource as any} onClose={()=>{}} onRefresh={()=>{}} onRevealFileInTree={()=>{}}/>;
    }
  `,
  );
  await writeFile(
    join(site, "ours.tsx"),
    `
    import {useState} from "react";
    import {ReviewPane} from "${root}/packages/desktop/src/renderer/ReviewPane.tsx";
    import "${root}/packages/ui/src/styles.css";
    export function Panel(){const [source,setSource]=useState("unstaged");return <ReviewPane sessionId="fixture" visible source={source as any} onSourceChange={setSource}/>;}
  `,
  );
  await writeFile(
    join(site, "main.tsx"),
    `
    import {createRoot} from "react-dom/client";
    import {data} from "./stub.ts";
    (window as any).__reviewBridge={getReview:async()=>({ok:true,value:{isRepository:true,entries:[{id:"fixture",path:data.path,status:"modified",area:"",added:3,removed:3}]}}), readReviewDiff:async()=>({ok:true,value:data}),onEvent:()=>()=>{}};
    document.documentElement.className="theme-zai-light";
    document.documentElement.dataset.theme="light";
    const {Panel}=location.pathname.includes("reference")?await import("./reference.tsx"):await import("./ours.tsx");
    const style=document.createElement("style");style.textContent='html,body,#root{margin:0;width:100%;height:100%;overflow:hidden;}body{font-family:ui-sans-serif,system-ui,sans-serif,"Apple Color Emoji","Segoe UI Emoji","Segoe UI Symbol","Noto Color Emoji";font-size:14px;line-height:1.5;}';document.head.append(style);
    createRoot(document.getElementById("root")!).render(<Panel/>);
  `,
  );
  const stubs = new Set([
    "@/hooks/useServices.js",
    "@/hooks/useFileContextActions.js",
    "@/hooks/useWorkspaceOpenInEditorTarget.js",
    "@/i18n/IntlProvider.js",
    "@/store/StoreProvider.js",
    "@/useTheme.js",
    "@/logger.js",
    "@/workspace-file-tree/model.js",
  ]);
  const config: InlineConfig = {
    configFile: false,
    root: site,
    publicDir: resolve("packages/desktop/src/renderer/public"),
    plugins: [
      tailwindcss(),
      {
        name: "review-fixture",
        enforce: "pre",
        resolveId(source, importer) {
          if (
            stubs.has(source) ||
            (importer?.endsWith("/ReviewPane.tsx") &&
              ["./store.ts", "./use-workspace.ts", "./pane-store.ts"].includes(source))
          )
            return join(site, "stub.ts");
          if (source === "zpi-ui" && importer?.endsWith("/ReviewPane.tsx")) return join(site, "shim.ts");
          if (source.startsWith("@/")) {
            const path = resolve(reference, source.slice(2));
            return [path, path.replace(/\.js$/, ".ts"), path.replace(/\.js$/, ".tsx")].find(existsSync);
          }
        },
        transform(code, id) {
          if (id.endsWith("/ReviewPane.tsx")) return code.replaceAll("window.zpi", "window.__reviewBridge");
        },
      },
    ],
    resolve: {
      dedupe: ["react", "react-dom", "@pierre/diffs"],
      alias: {
        react: resolve("node_modules/react"),
        "react-dom": resolve("node_modules/react-dom"),
        "@pierre/diffs/react": resolve("node_modules/@pierre/diffs/dist/react/index.js"),
        "@pierre/diffs": resolve("node_modules/@pierre/diffs/dist/index.js"),
      },
    },
    oxc: { jsx: { runtime: "automatic" } },
    server: { host: "127.0.0.1", port: 0, fs: { strict: false } },
    build: { outDir: join(site, "out"), emptyOutDir: true },
  };
  await build(config);
  const server = await preview({
    configFile: false,
    root: site,
    build: config.build,
    preview: { host: "127.0.0.1", port: 0 },
  });
  let app: Awaited<ReturnType<typeof launchDesktop>> | undefined;
  try {
    const address = server.httpServer.address();
    if (!address || typeof address === "string") throw Error("Missing fixture address");
    app = await launchDesktop({ dir, url: "" });
    const page = await app.firstWindow();
    page.setDefaultTimeout(10000);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(600, 850));
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    for (const mode of ["reference", "ours"]) {
      await page.goto(`http://127.0.0.1:${address.port}/${mode}`);
      await page.getByRole("button", { name: /ResetTest.java/ }).click();
      await expect(page.locator("diffs-container [data-unmodified-lines]").first()).toHaveText(
        "14 unmodified lines",
      );
      const metrics = await page.evaluate(() => {
        const header = document.querySelector('button[aria-expanded="true"]');
        const diff = document.querySelector("diffs-container");
        const section = document.querySelector("section");
        if (!header || !diff || !section) throw Error("Missing review fixture layout");
        return {
          header: header.getBoundingClientRect().toJSON(),
          font: getComputedStyle(header).font,
          diff: diff.getBoundingClientRect().toJSON(),
          fontCode: getComputedStyle(diff).getPropertyValue("--diffs-font-family"),
          background: getComputedStyle(section).backgroundColor,
        };
      });
      await writeFile(join(evidence, `${mode}-metrics.json`), JSON.stringify(metrics, null, 2));
      await page.mouse.move(0, 0);
      await page.screenshot({ path: join(evidence, `${mode}-folded-light.png`), animations: "disabled" });
      await page.getByRole("combobox").click();
      await writeFile(
        join(evidence, `${mode}-menu.json`),
        JSON.stringify(
          await page.getByRole("option").evaluateAll((elements) =>
            elements.map((element) => ({
              text: element.textContent,
              html: element.innerHTML,
              rect: element.getBoundingClientRect().toJSON(),
              color: getComputedStyle(element).color,
              opacity: getComputedStyle(element).opacity,
              visibility: getComputedStyle(element).visibility,
              ancestors: [
                element.parentElement,
                element.parentElement?.parentElement,
                element.parentElement?.parentElement?.parentElement,
              ].map((parent) =>
                parent
                  ? {
                      html: parent.outerHTML.slice(0, 400),
                      position: getComputedStyle(parent).position,
                      zIndex: getComputedStyle(parent).zIndex,
                      overflow: getComputedStyle(parent).overflow,
                      visibility: getComputedStyle(parent).visibility,
                      opacity: getComputedStyle(parent).opacity,
                      rect: parent.getBoundingClientRect().toJSON(),
                    }
                  : null,
              ),
              spans: [...element.querySelectorAll("span")].map((span) => ({
                text: span.textContent,
                rect: span.getBoundingClientRect().toJSON(),
                visibility: getComputedStyle(span).visibility,
                opacity: getComputedStyle(span).opacity,
                clip: getComputedStyle(span).clip,
                color: getComputedStyle(span).color,
              })),
            })),
          ),
          null,
          2,
        ),
      );
      await page.mouse.move(0, 0);
      await page.screenshot({
        path: join(evidence, `${mode}-source-menu-light.png`),
        animations: "disabled",
      });
      await page.keyboard.press("Escape");
      await page.locator("diffs-container [data-separator-first] [data-expand-button]").first().click();
      await page.locator("diffs-container [data-expand-both]").first().click();
      await page.locator("diffs-container [data-separator-last] [data-expand-button]").first().click();
      await page.mouse.move(0, 0);
      await page.evaluate(() => {
        let parent: HTMLElement | null = document.querySelector("diffs-container");
        while (
          parent &&
          !(parent.scrollHeight > parent.clientHeight && getComputedStyle(parent).overflowY === "auto")
        )
          parent = parent.parentElement;
        if (parent) parent.scrollTop = 500;
      });
      await page.evaluate(
        () =>
          new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
      );
      await page.screenshot({ path: join(evidence, `${mode}-expanded-light.png`), animations: "disabled" });
      await page.evaluate(() => {
        document.documentElement.className = "theme-zai-dark dark";
        document.documentElement.dataset.theme = "dark";
      });
      await page.getByRole("button", { name: /ResetTest.java/ }).click();
      await page.getByRole("button", { name: /ResetTest.java/ }).click();
      await expect(page.locator("diffs-container [data-unmodified-lines]").first()).toHaveText(
        "14 unmodified lines",
      );
      await page.mouse.move(0, 0);
      await page.screenshot({ path: join(evidence, `${mode}-folded-dark.png`), animations: "disabled" });
    }
    const comparisons: Record<string, unknown> = {};
    for (const state of ["folded-light", "source-menu-light", "expanded-light", "folded-dark"]) {
      const [referenceImage, oursImage] = await Promise.all(
        ["reference", "ours"].map(async (mode) =>
          (await readFile(join(evidence, `${mode}-${state}.png`))).toString("base64"),
        ),
      );
      const pixels = await page.evaluate(
        async ({ referenceImage, oursImage }) => {
          const decode = async (base64: string) => {
            const image = new Image();
            image.src = `data:image/png;base64,${base64}`;
            await image.decode();
            const canvas = document.createElement("canvas");
            canvas.width = image.width;
            canvas.height = image.height;
            const context = canvas.getContext("2d");
            if (!context) throw Error("Canvas decoder unavailable");
            context.drawImage(image, 0, 0);
            return {
              width: image.width,
              height: image.height,
              pixels: context.getImageData(0, 0, image.width, image.height).data,
            };
          };
          const [a, b] = await Promise.all([decode(referenceImage), decode(oursImage)]);
          let changed = 0,
            substantive = 0,
            code = 0;
          const scale = window.devicePixelRatio;
          for (let i = 0; i < a.pixels.length; i += 4) {
            const delta = Math.max(
              ...[0, 1, 2].map((channel) => Math.abs(a.pixels[i + channel] - b.pixels[i + channel])),
            );
            if (delta) changed++;
            if (delta > 2) substantive++;
            if (delta && Math.floor(i / 4 / a.width) >= 88 * scale) code++;
          }
          return { sameDimensions: a.width === b.width && a.height === b.height, changed, substantive, code };
        },
        { referenceImage, oursImage },
      );
      comparisons[state] = pixels;
      expect(pixels.sameDimensions).toBe(true);
      if (state !== "source-menu-light") expect(pixels.code).toBe(0);
      if (state !== "expanded-light") expect(pixels.substantive).toBe(0);
    }
    await writeFile(join(evidence, "comparison.json"), JSON.stringify(comparisons, null, 2));
    expect(errors).toEqual([]);
  } finally {
    await app?.close();
    await new Promise<void>((resolve) => server.httpServer.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});
