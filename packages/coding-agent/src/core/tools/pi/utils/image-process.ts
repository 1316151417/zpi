import { ImageProcessorError } from "./image-budget.ts";
import { formatDimensionNote, type ImageResizeOptions } from "./image-resize.ts";
import { resizeImageInProcess } from "./image-resize-core.ts";

export interface ProcessImageOptions {
  autoResizeImages?: boolean;
  resizeOptions?: ImageResizeOptions;
}
export type ProcessImageResult =
  | { ok: true; data: string; mimeType: string; hints: string[]; strategy?: string }
  | { ok: false; message: string; code?: string };

/** Attachments deliberately omit maxTokens: 5 MiB base64, unlike Read's 200,000 bytes. */
export async function processImage(
  bytes: Uint8Array,
  mimeType: string,
  options?: ProcessImageOptions,
): Promise<ProcessImageResult> {
  try {
    const resized = await resizeImageInProcess(
      bytes,
      mimeType,
      options?.resizeOptions,
      options?.autoResizeImages,
    );
    const hints: string[] = resized.animated ? ["[Animated image: only the first frame is sent.]"] : [];
    if (resized.originalMimeType !== resized.mimeType)
      hints.push(`[Image converted from ${resized.originalMimeType} to ${resized.mimeType}.]`);
    const dimensionNote = formatDimensionNote(resized);
    if (dimensionNote) hints.push(dimensionNote);
    if (resized.strategy !== "original")
      hints.push(
        "[Image compressed: small text, buttons and layout details may be unreadable. Compression success does not guarantee readability.]",
      );
    return { ok: true, data: resized.data, mimeType: resized.mimeType, hints, strategy: resized.strategy };
  } catch (error) {
    const code = error instanceof ImageProcessorError ? error.code : "processing_failed";
    return {
      ok: false,
      code,
      message: `[Image omitted: ${code}. ${error instanceof Error ? error.message : "Unable to process image"}.]`,
    };
  }
}
