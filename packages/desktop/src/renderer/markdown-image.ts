import type { FileLocation } from "zpi-ui/links";
import { unwrap } from "./unwrap.ts";

export async function readMarkdownImage(
  sessionId: string,
  path: string,
  location?: FileLocation,
): Promise<string> {
  const preview = unwrap(await window.zpi.readFilePreview(sessionId, path, location));
  if (preview.kind === "text" && /\.svg$/i.test(preview.path) && preview.truncated)
    throw new Error("SVG 超过预览大小限制，无法显示完整图片");
  const blob =
    preview.kind === "text" && /\.svg$/i.test(preview.path)
      ? new Blob([preview.text], { type: "image/svg+xml" })
      : preview.kind === "image"
        ? new Blob([new Uint8Array(preview.bytes)], { type: preview.mime })
        : undefined;
  if (!blob) throw new Error("文件不是图片");
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}
