import { getSingularPatch, parseDiffFromFile } from "@pierre/diffs";
import type { FindTarget } from "./find.ts";
import { patchFindTargets } from "./patch-find.ts";
import { getPatchPreviewLineContent, parseTruncatedMarkerOmittedLineCount } from "./patch-preview.ts";
import { getGitPaneDiffPreviewPlan, type ReviewDiffData } from "./review-diff.ts";

export function reviewFindTargets(id: string, diff: ReviewDiffData): FindTarget[] {
  if (diff.availability !== "patch") return [];
  const plan = getGitPaneDiffPreviewPlan(diff);
  const plain =
    plan.kind === "plain-text"
      ? plan.lines.flatMap((line, index) =>
          parseTruncatedMarkerOmittedLineCount(line) !== null
            ? []
            : [
                {
                  key: `${id}:plain:${index}`,
                  path: diff.path,
                  text: getPatchPreviewLineContent(line),
                },
              ],
        )
      : [];
  if (diff.beforeContent === null || diff.afterContent === null)
    return plan.kind === "plain-text" ? plain : patchFindTargets(id, diff.path, diff.patch ?? "");
  if (plan.kind !== "rich") {
    const keys = [new Map<number, string>(), new Map<number, string>()];
    try {
      const patch = getSingularPatch(diff.patch ?? "");
      const visible = plan.kind === "plain-text" ? plain : patchFindTargets(id, diff.path, patch);
      let index = 0;
      const key = (line: string) => {
        const target = visible[index++];
        return target?.text === line.replace(/\r?\n$/, "") ? target.key : undefined;
      };
      for (const hunk of patch.hunks) {
        let old = hunk.deletionLineIndex,
          next = hunk.additionLineIndex;
        const assign = (side: number, line: number, value: string | undefined) => {
          if (value) keys[side].set(line, value);
        };
        for (const content of hunk.hunkContent) {
          if (content.type === "context") {
            for (let i = 0; i < content.lines; i++) {
              const value = key(patch.additionLines[next]);
              assign(0, old++, value);
              assign(1, next++, value);
            }
          } else {
            for (let i = 0; i < content.deletions; i++) assign(0, old, key(patch.deletionLines[old++]));
            for (let i = 0; i < content.additions; i++) assign(1, next, key(patch.additionLines[next++]));
          }
        }
      }
    } catch {
      // Metadata-only or malformed fallbacks have no reliable patch coordinates.
    }
    return [diff.beforeContent, diff.afterContent].flatMap((content, side) => {
      const lines = content.split(/\r?\n/);
      if (content.endsWith("\n")) lines.pop();
      return lines.map((text, index) => ({
        key: keys[side].get(index) ?? `${id}:hidden:${side}:${index}`,
        path: diff.path,
        text,
      }));
    });
  }
  const parsed = parseDiffFromFile(
    { name: diff.path, contents: diff.beforeContent },
    { name: diff.path, contents: diff.afterContent },
  );
  const before: FindTarget[] = [],
    after: FindTarget[] = [];
  let old = 0,
    current = 0,
    unified = 0;
  const target = (text: string): FindTarget => ({
    key: `${id}:${unified}`,
    path: diff.path,
    text: text.replace(/\r?\n$/, ""),
  });
  const context = () => {
    const line = target(parsed.additionLines[current++]);
    before.push(line);
    after.push(line);
    old++;
    unified++;
  };
  for (const hunk of parsed.hunks) {
    while (current < hunk.additionLineIndex) context();
    for (const content of hunk.hunkContent) {
      if (content.type === "context") {
        for (let i = 0; i < content.lines; i++) context();
      } else {
        for (let i = 0; i < content.deletions; i++) {
          before.push(target(parsed.deletionLines[old++]));
          unified++;
        }
        for (let i = 0; i < content.additions; i++) {
          after.push(target(parsed.additionLines[current++]));
          unified++;
        }
      }
    }
  }
  while (current < parsed.additionLines.length) context();
  // ZCode searches before, then after. Unchanged text counts once per snapshot even in unified view.
  return [...before, ...after];
}
