export const imageLimits = {
  sourceBytes: 10 * 1024 * 1024,
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
