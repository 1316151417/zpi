import { open, realpath } from "node:fs/promises";
import { extname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { FileLocation } from "zpi-ui/links";
import type { FilePreview } from "../shared/bridge.ts";
import { isPathInside } from "./path-bounds.ts";

const imageTypes: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  bmp: "image/bmp",
  avif: "image/avif",
};
const mediaTypes: Record<string, string> = {
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  m4a: "audio/mp4",
  flac: "audio/flac",
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
};

export async function readFilePreview(cwd: string, target: string, input?: unknown): Promise<FilePreview> {
  if (!target || target.includes("\0") || target.length > 8192)
    throw new Error("invalid_input: 文件路径无效");
  const location = validateLocation(input);
  if (process.platform !== "win32" && /^(?:[a-z]:[\\/]|\\\\|\/\/)/i.test(target))
    throw new Error("invalid_input: 当前系统无法打开 Windows 文件路径");
  let path = target;
  if (/^file:/i.test(target)) {
    const url = new URL(target);
    if (url.hostname && url.hostname !== "localhost") throw new Error("invalid_input: 仅支持本地文件");
    path = fileURLToPath(url);
  }
  // Keep filesystem access in main. References may point to generated files outside the workspace.
  const bounded = location?.relative || !isAbsolute(path);
  const candidate = resolve(cwd, path);
  const inside = (root: string, actual: string) => {
    if (!isPathInside(root, actual)) throw new Error("invalid_input: 相对文件链接超出当前工作目录");
  };
  if (bounded) inside(resolve(cwd), candidate);
  try {
    path = await realpath(candidate);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      throw new Error(`not_found: 文件不存在：${candidate}`);
    throw error;
  }
  if (bounded) inside(await realpath(cwd), path);
  const file = await open(path, "r");
  try {
    const stat = await file.stat();
    if (!stat.isFile()) throw new Error("invalid_input: 无法预览文件夹");
    const extension = extname(path).slice(1).toLowerCase();
    const mime = imageTypes[extension] ?? mediaTypes[extension];
    const kind = imageTypes[extension]
      ? "image"
      : mediaTypes[extension]
        ? "media"
        : extension === "xlsx" || extension === "docx"
          ? extension
          : "text";
    const limit = kind === "text" ? 2 * 1024 * 1024 : 32 * 1024 * 1024;
    if (kind !== "text" && stat.size > limit) throw new Error("invalid_input: 文件超过 32 MB 预览限制");
    const bytes = Buffer.alloc(Math.min(stat.size, limit));
    let bytesRead = 0;
    while (bytesRead < bytes.length) {
      const chunk = await file.read(bytes, bytesRead, bytes.length - bytesRead, bytesRead);
      if (!chunk.bytesRead) break;
      bytesRead += chunk.bytesRead;
    }
    const data = bytes.subarray(0, bytesRead);
    if (kind !== "text") return { path, location, kind, mime, bytes: new Uint8Array(data) };
    if (data.includes(0)) return { path, location, kind: "unsupported" };
    return {
      path,
      location,
      kind: "text",
      text: new TextDecoder().decode(data),
      truncated: stat.size > bytesRead,
    };
  } finally {
    await file.close();
  }
}

function validateLocation(input: unknown): FileLocation | undefined {
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
