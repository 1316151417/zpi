// ZCode DiffsWorkerPoolProvider defaults (Apache-2.0).
import { WorkerPoolContextProvider } from "@pierre/diffs/react";
import type { ReactNode } from "react";

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
export function DiffsWorkerPool({ children }: { children: ReactNode }) {
  return (
    <WorkerPoolContextProvider poolOptions={poolOptions} highlighterOptions={highlighterOptions}>
      {children}
    </WorkerPoolContextProvider>
  );
}
