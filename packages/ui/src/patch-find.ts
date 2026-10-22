import { type FileDiffMetadata, getSingularPatch } from "@pierre/diffs";
import type { FindTarget } from "./find.ts";

/** Use the diff renderer's line indices; headers and diff markers are not searchable text. */
export function patchFindTargets(id: string, path: string, patch: string | FileDiffMetadata): FindTarget[] {
  try {
    const diff = typeof patch === "string" ? getSingularPatch(patch) : patch;
    const targets: FindTarget[] = [];
    for (const hunk of diff.hunks) {
      let unified = hunk.unifiedLineStart,
        addition = hunk.additionLineIndex,
        deletion = hunk.deletionLineIndex;
      const add = (text: string) =>
        targets.push({ key: `${id}:${unified++}`, path, text: text.replace(/\r?\n$/, "") });
      for (const content of hunk.hunkContent) {
        if (content.type === "context") {
          for (let i = 0; i < content.lines; i++) add(diff.additionLines[addition++]);
          deletion += content.lines;
        } else {
          for (let i = 0; i < content.deletions; i++) add(diff.deletionLines[deletion++]);
          for (let i = 0; i < content.additions; i++) add(diff.additionLines[addition++]);
        }
      }
    }
    return targets;
  } catch {
    if (typeof patch !== "string") return [];
    return patch
      .split("\n")
      .flatMap((line, index) =>
        /^[ +-]/.test(line) && !/^(---|\+\+\+) /.test(line)
          ? [{ key: `${id}:plain:${index}`, path, text: line.slice(1) }]
          : [],
      );
  }
}
