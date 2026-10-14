// Adapted from Pi c20cb09772bf4e2590a316cb54514cef76df4293.
// Copyright (c) 2025 Mario Zechner. MIT license: THIRD_PARTY_NOTICES.md.
import { openImage } from "./image-source.ts";

export interface ImageResizeOptions {
  maxWidth?: number; // Default: 2000
  maxHeight?: number; // Default: 2000
  maxBytes?: number; // Default: 4.5 MiB of base64 payload
  jpegQuality?: number; // Default: 80
}

export interface ResizedImage {
  data: string;
  mimeType: string;
  originalWidth: number;
  originalHeight: number;
  width: number;
  height: number;
  wasResized: boolean;
  originalMimeType?: string;
  animated?: boolean;
}

// A conservative shared inline budget. Providers may impose additional request-wide limits.
const DEFAULT_OPTIONS: Required<ImageResizeOptions> = {
  maxWidth: 2000,
  maxHeight: 2000,
  maxBytes: 4.5 * 1024 * 1024,
  jpegQuality: 80,
};

/** Preserve fitting originals; otherwise try lossless PNG, then JPEG, then smaller dimensions. */
export async function resizeImageInProcess(
  inputBytes: Uint8Array,
  _mimeType: string,
  options?: ImageResizeOptions,
): Promise<ResizedImage | null> {
  const opts = {
    maxWidth: options?.maxWidth ?? DEFAULT_OPTIONS.maxWidth,
    maxHeight: options?.maxHeight ?? DEFAULT_OPTIONS.maxHeight,
    maxBytes: options?.maxBytes ?? DEFAULT_OPTIONS.maxBytes,
    jpegQuality: options?.jpegQuality ?? DEFAULT_OPTIONS.jpegQuality,
  };
  if (
    ![opts.maxWidth, opts.maxHeight, opts.maxBytes, opts.jpegQuality].every(
      (value) => Number.isSafeInteger(value) && value > 0,
    ) ||
    opts.jpegQuality > 100
  )
    return null;

  try {
    const source = await openImage(inputBytes);
    const originalWidth = source.width;
    const originalHeight = source.height;
    const scale = Math.min(1, opts.maxWidth / originalWidth, opts.maxHeight / originalHeight);
    let width = Math.max(1, Math.round(originalWidth * scale));
    let height = Math.max(1, Math.round(originalHeight * scale));
    const result = (bytes: Uint8Array, mimeType: string): ResizedImage => ({
      data: Buffer.from(bytes).toString("base64"),
      mimeType,
      originalMimeType: source.mimeType,
      animated: source.animated,
      originalWidth,
      originalHeight,
      width,
      height,
      wasResized: width !== originalWidth || height !== originalHeight,
    });
    const fits = (bytes: Uint8Array) => Math.ceil(bytes.byteLength / 3) * 4 <= opts.maxBytes;

    if (
      scale === 1 &&
      fits(inputBytes) &&
      !source.animated &&
      !source.hasMetadata &&
      source.orientation === 1 &&
      source.mimeType !== "image/bmp"
    ) {
      await source.pipeline.stats();
      return result(inputBytes, source.mimeType);
    }

    const qualities = [opts.jpegQuality, ...[85, 70, 55, 40].filter((quality) => quality < opts.jpegQuality)];
    while (true) {
      const resized = source.pipeline.clone().rotate().resize(width, height, { fit: "fill" });
      const png = await resized.clone().png().toBuffer();
      if (fits(png)) return result(png, "image/png");
      for (const quality of qualities) {
        const jpeg = await resized.clone().flatten({ background: "white" }).jpeg({ quality }).toBuffer();
        if (fits(jpeg)) return result(jpeg, "image/jpeg");
      }
      if (width === 1 && height === 1) return null;
      width = Math.max(1, Math.floor(width * 0.75));
      height = Math.max(1, Math.floor(height * 0.75));
    }
  } catch {
    return null;
  }
}
