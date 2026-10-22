import { parseDiffFromFile } from "@pierre/diffs";
import type { FindTarget } from "./find.ts";
import { patchFindTargets } from "./patch-find.ts";
import { getPatchPreviewLineContent, parseTruncatedMarkerOmittedLineCount } from "./patch-preview.ts";
import { getGitPaneDiffPreviewPlan, type ReviewDiffData } from "./review-diff.ts";

export function reviewFindTargets(id: string, diff: ReviewDiffData): FindTarget[] {
  if (diff.availability !== "patch") return [];
  const plan = getGitPaneDiffPreviewPlan(diff);
  if (plan.kind === "plain-text")
    return plan.lines.flatMap((line, index) =>
      parseTruncatedMarkerOmittedLineCount(line) !== null
        ? []
        : [{ key: `${id}:plain:${index}`, path: diff.path, text: getPatchPreviewLineContent(line) }],
    );
  if (plan.kind === "patch" || diff.beforeContent === null || diff.afterContent === null)
    return patchFindTargets(id, diff.path, diff.patch ?? "");
  const parsed = parseDiffFromFile(
    { name: diff.path, contents: diff.beforeContent },
    { name: diff.path, contents: diff.afterContent },
  );
  const targets: FindTarget[] = [];
  let old = 0,
    current = 0;
  const add = (text: string) =>
    targets.push({ key: `${id}:${targets.length}`, path: diff.path, text: text.replace(/\r?\n$/, "") });
  for (const hunk of parsed.hunks) {
    while (current < hunk.additionLineIndex) {
      add(parsed.additionLines[current++]);
      old++;
    }
    for (const content of hunk.hunkContent) {
      if (content.type === "context") {
        for (let i = 0; i < content.lines; i++) {
          add(parsed.additionLines[current++]);
          old++;
        }
      } else {
        for (let i = 0; i < content.deletions; i++) add(parsed.deletionLines[old++]);
        for (let i = 0; i < content.additions; i++) add(parsed.additionLines[current++]);
      }
    }
  }
  while (current < parsed.additionLines.length) add(parsed.additionLines[current++]);
  return targets;
}
