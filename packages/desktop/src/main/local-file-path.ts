import type { FileLocation } from "ZPI-ui/links";
import { realpath } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { isPathInside } from "./path-bounds.ts";

export function localFileCandidate(cwd: string, target: string, bounded = !isAbsolute(target)): string {
  const path = resolve(cwd, target);
  if (bounded && !isPathInside(resolve(cwd), path))
    throw new Error("invalid_input: 相对文件链接超出当前工作目录");
  return path;
}

export async function resolveLocalFilePath(
  cwd: string,
  target: string,
  bounded = !isAbsolute(target),
): Promise<string> {
  const candidate = localFileCandidate(cwd, target, bounded);
  let path: string;
  try {
    path = await realpath(candidate);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      throw new Error(`not_found: 文件不存在：${candidate}`);
    throw error;
  }
  if (bounded && !isPathInside(await realpath(cwd), path))
    throw new Error("invalid_input: 相对文件链接超出当前工作目录");
  return path;
}

export function validateFileLocation(input: unknown): FileLocation | undefined {
  if (input === undefined) return undefined;
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("invalid_input: 文件定位信息无效");
  const value = input as Record<string, unknown>;
  for (const [key, item] of Object.entries(value)) {
    if (item === undefined) continue;
    if (key === "fileUrl") {
      if (typeof item !== "string" || item.length > 8192 || new URL(item).protocol !== "file:")
        throw new Error("invalid_input: 文件预览 URL 无效");
      continue;
    }
    if (
      key === "relative"
        ? typeof item !== "boolean"
        : !["line", "column", "endLine"].includes(key) || !Number.isSafeInteger(item) || (item as number) < 1
    )
      throw new Error("invalid_input: 文件定位信息无效");
  }
  if ((value.column !== undefined || value.endLine !== undefined) && value.line === undefined)
    throw new Error("invalid_input: 文件定位缺少行号");
  if (typeof value.endLine === "number" && typeof value.line === "number" && value.endLine < value.line)
    throw new Error("invalid_input: 文件定位范围无效");
  return value as FileLocation;
}
