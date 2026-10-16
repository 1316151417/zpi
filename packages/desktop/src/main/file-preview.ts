import { open, stat } from "node:fs/promises";
import { extname, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { MEDIA_PREVIEW_FORMATS } from "zpi-ui/media-preview";
import type { FilePreview } from "../shared/bridge.ts";
import { resolveLocalFilePath, validateFileLocation } from "./local-file-path.ts";

const imageTypes: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  avif: "image/avif",
  apng: "image/apng",
  ico: "image/x-icon",
};

export async function readFilePreview(cwd: string, target: string, input?: unknown): Promise<FilePreview> {
  const location = validateFileLocation(input);
  const path = await resolvePreviewPath(cwd, target, input);
  if ((await stat(path)).isDirectory()) return { path, location, kind: "directory" };
  const file = await open(path, "r");
  try {
    const stat = await file.stat();
    if (!stat.isFile()) throw new Error("invalid_input: 无法预览文件夹");
    const extension = extname(path).slice(1).toLowerCase();
    const mediaType = MEDIA_PREVIEW_FORMATS.find((format) => format.extension === `.${extension}`)?.mediaType;
    const mime = imageTypes[extension] ?? mediaType;
    const kind = imageTypes[extension]
      ? "image"
      : mediaType
        ? "media"
        : ["xlsx", "xlsm", "xls"].includes(extension)
          ? "xlsx"
          : extension === "docx" || extension === "doc" || extension === "pdf" || extension === "pptx"
            ? extension
            : "text";
    const limit = kind === "text" ? 2 * 1024 * 1024 : (kind === "pptx" ? 64 : 32) * 1024 * 1024;
    if (kind !== "text" && kind !== "pdf" && stat.size > limit)
      throw new Error(`invalid_input: 文件超过 ${limit / 1024 / 1024} MB 预览限制`);
    const partialPdf = kind === "pdf" && stat.size > 2 * 1024 * 1024;
    const bytes = Buffer.alloc(Math.min(stat.size, partialPdf ? 256 * 1024 : limit));
    let bytesRead = 0;
    while (bytesRead < bytes.length) {
      const chunk = await file.read(bytes, bytesRead, bytes.length - bytesRead, bytesRead);
      if (!chunk.bytesRead) break;
      bytesRead += chunk.bytesRead;
    }
    const data = bytes.subarray(0, bytesRead);
    if (kind !== "text")
      return {
        path,
        location,
        kind,
        mime,
        bytes: new Uint8Array(data),
        ...(partialPdf ? { totalBytes: stat.size } : {}),
      };
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

async function resolvePreviewPath(cwd: string, target: string, input?: unknown): Promise<string> {
  if (!target || target.includes("\0") || target.length > 8192)
    throw new Error("invalid_input: 文件路径无效");
  const location = validateFileLocation(input);
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
  path = await resolveLocalFilePath(cwd, path, bounded);
  return path;
}

export async function readPreviewRange(
  cwd: string,
  target: string,
  offset: unknown,
  length: unknown,
): Promise<Uint8Array> {
  if (
    typeof offset !== "number" ||
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    typeof length !== "number" ||
    !Number.isSafeInteger(length) ||
    length < 1 ||
    length > 1024 * 1024
  ) {
    throw new Error("invalid_input: 文件读取范围无效");
  }
  const path = await resolvePreviewPath(cwd, target);
  if (extname(path).toLowerCase() !== ".pdf") throw new Error("invalid_input: 仅支持 PDF 分段预览");
  const file = await open(path, "r");
  try {
    const info = await file.stat();
    if (!info.isFile() || offset + length > info.size) throw new Error("invalid_input: 文件读取范围越界");
    const bytes = Buffer.alloc(length);
    let read = 0;
    while (read < length) {
      const result = await file.read(bytes, read, length - read, offset + read);
      if (!result.bytesRead) throw new Error("invalid_input: 文件已变化，请刷新预览");
      read += result.bytesRead;
    }
    return new Uint8Array(bytes);
  } finally {
    await file.close();
  }
}
