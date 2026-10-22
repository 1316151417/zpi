import type { DiffItem } from "./bridge.ts";

export type { ReviewDiffData } from "zpi-ui";

export const reviewSources = {
  unstaged: "未暂存",
  staged: "已暂存",
  branch: "全部分支更改",
  "last-turn": "上一轮更改",
} as const;
export type ReviewSource = keyof typeof reviewSources;
export interface ReviewSnapshot {
  entries: DiffItem[];
  isRepository: boolean;
  isGitAvailable?: boolean;
  runId?: string;
  watchPaths?: string[];
}
export function reviewPatchStats(patch: string | undefined) {
  let added = 0;
  let removed = 0;
  let hunk = false;
  for (const line of patch?.split("\n") ?? []) {
    if (line.startsWith("@@ ")) hunk = true;
    else if (hunk && line.startsWith("+")) added++;
    else if (hunk && line.startsWith("-")) removed++;
  }
  return { added, removed };
}
