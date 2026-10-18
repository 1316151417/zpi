// Adapted from Pi c20cb09772bf4e2590a316cb54514cef76df4293.
// Copyright (c) 2025 Mario Zechner. MIT license: THIRD_PARTY_NOTICES.md.
import { type ResizedImage, resizeImageInProcess } from "./image-resize-core.ts";

export type { ImageResizeOptions, ResizedImage } from "./image-resize-core.ts";
export async function resizeImage(...args: Parameters<typeof resizeImageInProcess>) {
  try {
    return await resizeImageInProcess(...args);
  } catch {
    return null;
  }
}
export function formatDimensionNote(result: ResizedImage): string | undefined {
  if (!result.wasResized) {
    return undefined;
  }

  const scaleX = (result.originalWidth / result.width).toFixed(2);
  const scaleY = (result.originalHeight / result.height).toFixed(2);
  const scale = scaleX === scaleY ? scaleX : `${scaleX} horizontally and ${scaleY} vertically`;
  return `[Image: original ${result.originalWidth}x${result.originalHeight}, displayed at ${result.width}x${result.height}. Multiply coordinates by ${scale} to map to original image.]`;
}
