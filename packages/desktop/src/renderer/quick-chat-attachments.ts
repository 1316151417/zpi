import { type ImageAttachment, imageLimits } from "zpi-coding-agent/input";
import { unwrap } from "./unwrap.ts";

export interface QuickChatDraftImage {
  key: number;
  file: File;
  image?: ImageAttachment;
  status: "queued" | "importing" | "ready" | "failed" | "removing";
  error?: string;
}

/** Only Files supplied by a paste event enter the temporary attachment bridge. */
export function pastedImages(data: DataTransfer): File[] {
  const items = Array.from(data.items ?? [])
    .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
    .map((item) => item.getAsFile())
    .filter((file): file is File => Boolean(file));
  return items.length ? items : Array.from(data.files ?? []).filter((file) => file.type.startsWith("image/"));
}

export function imageImportError(file: File): string | undefined {
  if (!file.size) return "图片为空，请重新复制图片。";
  if (file.size > imageLimits.sourceBytes) return "图片单张上限为 10 MiB。";
}

export async function readQuickChatAttachment(sessionId: string, id: string): Promise<string> {
  const result = unwrap(await window.zpiQuickChat.readAttachment(sessionId, id));
  return `data:${result.metadata.mimeType};base64,${result.data}`;
}
