// Read's token budget is independent of the model's output token limit.
export const READ_MAX_OUTPUT_TOKENS = 25_000;
export const READ_IMAGE_MAX_BASE64_BYTES = 5 * 1024 * 1024;
export const READ_IMAGE_TARGET_BYTES = Math.floor((READ_IMAGE_MAX_BASE64_BYTES * 3) / 4);
export const READ_IMAGE_MAX_DIMENSION = 2000;
export const READ_IMAGE_MAX_INPUT_BYTES = 20 * 1024 * 1024;
export const READ_IMAGE_TOKEN_TO_BASE64_CHAR_RATIO = 0.125;
// Invert tokens = base64 characters × ratio. Do not substitute model.maxTokens here.
export const READ_IMAGE_EFFECTIVE_BASE64_BYTES = Math.floor(
  READ_MAX_OUTPUT_TOKENS / READ_IMAGE_TOKEN_TO_BASE64_CHAR_RATIO,
);

export const imageLimits = {
  /** Imported and cached attachment originals. */
  sourceBytes: 10 * 1024 * 1024,
  /** Local/remote read-tool image inputs; attachments retain their stricter import cap. */
  readSourceBytes: READ_IMAGE_MAX_INPUT_BYTES,
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
