import type { FileLocation } from "zpi-ui/links";
import { unwrap } from "./store.ts";

export async function readMarkdownImage(
  sessionId: string,
  path: string,
  location?: FileLocation,
): Promise<string> {
  const preview = unwrap(await window.zpi.readFilePreview(sessionId, path, location));
  if (preview.kind !== "image") throw new Error("文件不是图片");
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(new Blob([new Uint8Array(preview.bytes)], { type: preview.mime }));
  });
}
