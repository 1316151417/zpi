export const imageLimits = {
  /** Imported and cached attachment originals. */
  sourceBytes: 10 * 1024 * 1024,
  /** Local/remote read-tool image inputs; attachments retain their stricter import cap. */
  readSourceBytes: 20 * 1024 * 1024,
  count: 8,
  pixels: 40_000_000,
  messagePixels: 80_000_000,
} as const;
export interface ImageAttachment {
  id: string;
  name: string;
  mimeType: string;
  width: number;
  height: number;
  size: number;
  warning?: string;
}
export interface FileAttachment {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  path: string;
}
export type Attachment = ImageAttachment | FileAttachment;
export function isImageAttachment(attachment: Attachment): attachment is ImageAttachment {
  return "width" in attachment;
}
