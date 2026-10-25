import { type FileDiffMetadata, parsePatchFiles } from "@pierre/diffs";
import type { FindTarget } from "./find.ts";

export type PatchFindTarget = FindTarget & { patchLine?: number };

/** Count hunk body lines before interpreting header-like source text. */
function bodyTargets(id: string, path: string, patch: string): PatchFindTarget[] {
  let old = 0,
    current = 0,
    sawHunk = false;
  return patch.split(/\r?\n/).flatMap((line, index) => {
    const hunk = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(line);
    if (hunk) {
      old = Number(hunk[1] ?? 1);
      current = Number(hunk[2] ?? 1);
      sawHunk = true;
      return [];
    }
    const kind = line[0];
    if (!/^[ +-]/.test(line)) return [];
    if (sawHunk ? !old && !current : /^(---|\+\+\+) /.test(line)) return [];
    if (kind !== "+") old = Math.max(0, old - 1);
    if (kind !== "-") current = Math.max(0, current - 1);
    return [{ key: `${id}:plain:${index}`, path, text: line.slice(1), patchLine: index }];
  });
}

/** Use the diff renderer's line indices; headers and diff markers are not searchable text. */
export function patchFindTargets(
  id: string,
  path: string,
  patch: string | FileDiffMetadata,
): PatchFindTarget[] {
  const body = typeof patch === "string" ? bodyTargets(id, path, patch) : undefined;
  try {
    const patches = typeof patch === "string" ? parsePatchFiles(patch, undefined, true) : undefined;
    const diff =
      typeof patch === "string"
        ? patches?.length === 1 && patches[0].files.length === 1
          ? patches[0].files[0]
          : undefined
        : patch;
    if (!diff) return body ?? [];
    const targets: PatchFindTarget[] = [];
    for (const hunk of diff.hunks) {
      let unified = hunk.unifiedLineStart,
        addition = hunk.additionLineIndex,
        deletion = hunk.deletionLineIndex;
      const add = (text: string) => {
        const target: PatchFindTarget = { key: `${id}:${unified++}`, path, text: text.replace(/\r?\n$/, "") };
        if (body) target.patchLine = body[targets.length]?.patchLine;
        targets.push(target);
      };
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
    if (!body) return targets;
    if (body.length !== targets.length || body.some((target, index) => target.text !== targets[index].text))
      return body;
    return targets;
  } catch {
    return body ?? [];
  }
}
