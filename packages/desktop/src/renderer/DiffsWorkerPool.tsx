// ZCode DiffsWorkerPoolProvider defaults (Apache-2.0).
import { useWorkerPool, WorkerPoolContextProvider } from "@pierre/diffs/react";
import { type ReactNode, useEffect, useMemo } from "react";
import { defaultCodePreview } from "zpi-ui/code-preview";
import { report, useStore } from "./store.ts";

const poolOptions = {
  workerFactory: () =>
    new Worker(new URL("./diffs.worker.ts", import.meta.url), { type: "module", name: "zpi-diffs-worker" }),
  poolSize: Math.max(1, Math.min(4, Math.floor((navigator.hardwareConcurrency || 4) / 2))),
};
const highlighterOptions = {
  theme: { light: "github-light", dark: "github-dark" },
  lineDiffType: "word-alt" as const,
  maxLineDiffLength: 1_000,
  tokenizeMaxLineLength: 1_000,
  useTokenTransformer: false,
  preferredHighlighter: "shiki-wasm" as const,
};
function WorkerOptionsSync({ options }: { options: typeof highlighterOptions }) {
  const pool = useWorkerPool();
  useEffect(() => {
    void pool?.setRenderOptions(options).catch(report);
  }, [pool, options]);
  return null;
}
export function DiffsWorkerPool({ children }: { children: ReactNode }) {
  const settings = useStore((state) => state.settings?.interface.codePreview ?? defaultCodePreview);
  const options = useMemo(
    () => ({
      ...highlighterOptions,
      theme: { light: settings.lightTheme, dark: settings.darkTheme },
    }),
    [settings.lightTheme, settings.darkTheme],
  );
  if (typeof Worker === "undefined") return children;
  return (
    <WorkerPoolContextProvider poolOptions={poolOptions} highlighterOptions={options}>
      <WorkerOptionsSync options={options} />
      {children}
    </WorkerPoolContextProvider>
  );
}
