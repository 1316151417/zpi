import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createTwoFilesPatch, parsePatch } from "diff";
export interface FileChange {
  path: string;
  operation: "created" | "modified";
  toolCallId: string;
  beforeHash: string | null;
  afterHash: string;
  patch?: string;
  patchFile?: string;
  beforeFile?: string;
  afterFile?: string;
  reason?: string;
  failed?: boolean;
  additions?: number;
  deletions?: number;
}
export async function beforeFile(path: string): Promise<Buffer | null> {
  try {
    return await readFile(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}
const hash = (b: Buffer) => createHash("sha256").update(b).digest("hex");
export async function recordFileChange(
  path: string,
  toolCallId: string,
  before: Buffer | null,
  outputDir?: string,
  failed = false,
): Promise<FileChange | undefined> {
  const after = await readFile(path);
  if (before?.equals(after)) return undefined;
  const change: FileChange = {
    path,
    toolCallId,
    operation: before === null ? "created" : "modified",
    beforeHash: before === null ? null : hash(before),
    afterHash: hash(after),
    ...(failed ? { failed } : {}),
  };
  try {
    if ((before?.length ?? 0) + after.length > 4 * 1024 * 1024 || before?.includes(0) || after.includes(0))
      return { ...change, reason: "二进制或文件超限，无法内联比较" };
    const decode = new TextDecoder("utf8", { fatal: true });
    const beforeText = before === null ? "" : decode.decode(before),
      afterText = decode.decode(after);
    if (outputDir) {
      await mkdir(outputDir, { recursive: true });
      const key = randomUUID();
      if (before !== null) {
        change.beforeFile = join(outputDir, `${key}.before`);
        await writeFile(change.beforeFile, beforeText, { mode: 0o600 });
      }
      change.afterFile = join(outputDir, `${key}.after`);
      await writeFile(change.afterFile, afterText, { mode: 0o600 });
    }
    const patch = createTwoFilesPatch(
      before === null ? "/dev/null" : path,
      path,
      beforeText,
      afterText,
      "",
      "",
      { context: 3, timeout: 1000 },
    );
    if (patch === undefined) return { ...change, reason: "文件已修改，diff 计算超时，无法内联比较" };
    Object.assign(change, patchLineCounts(patch));
    if (Buffer.byteLength(patch) <= 64 * 1024) change.patch = patch;
    else if (outputDir) {
      await mkdir(outputDir, { recursive: true });
      change.patchFile = join(outputDir, `${randomUUID()}.patch`);
      await writeFile(change.patchFile, patch, { mode: 0o600 });
    } else change.reason = "Patch 超限；未配置记录目录";
  } catch (e) {
    change.reason = `文件已修改，但记录不可用: ${String(e)}`;
  }
  return change;
}

export function patchLineCounts(patch: string): { additions: number; deletions: number } {
  let additions = 0,
    deletions = 0;
  for (const file of parsePatch(patch))
    for (const hunk of file.hunks)
      for (const line of hunk.lines) {
        if (line.startsWith("+")) additions++;
        if (line.startsWith("-")) deletions++;
      }
  return { additions, deletions };
}
