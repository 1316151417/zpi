// Adapted from Pi c20cb09772bf4e2590a316cb54514cef76df4293.
// Copyright (c) 2025 Mario Zechner. MIT license: THIRD_PARTY_NOTICES.md.

import { formatDimensionNote, type ImageResizeOptions, resizeImage } from "./image-resize.ts";
import { openImage } from "./image-source.ts";

export interface ProcessImageOptions {
  /** Whether to resize images to inline provider limits. Default: true */
  autoResizeImages?: boolean;
  /** Optional resize overrides. Uses resizeImage defaults when omitted. */
  resizeOptions?: ImageResizeOptions;
}

export type ProcessImageResult =
  | {
      ok: true;
      data: string;
      mimeType: string;
      hints: string[];
    }
  | {
      ok: false;
      message: string;
    };

interface NormalizedImage {
  bytes: Uint8Array;
  mimeType: string;
  convertedFrom?: string;
  animated?: boolean;
}

async function normalizeImage(bytes: Uint8Array): Promise<NormalizedImage | null> {
  try {
    const source = await openImage(bytes);
    // Inline providers receive one physically oriented frame, regardless of format or size.
    if (
      source.mimeType === "image/bmp" ||
      source.animated ||
      source.orientation !== 1 ||
      source.hasMetadata
    ) {
      return {
        bytes: await source.pipeline.rotate().png().toBuffer(),
        mimeType: "image/png",
        convertedFrom: source.mimeType,
        ...(source.animated ? { animated: true } : {}),
      };
    }
    await source.pipeline.stats();
    return { bytes, mimeType: source.mimeType };
  } catch {
    return null;
  }
}

function conversionHint(from: string | undefined, to: string): string | undefined {
  if (!from || from === to) return undefined;
  return `[Image converted from ${from} to ${to}.]`;
}

export async function processImage(
  bytes: Uint8Array,
  mimeType: string,
  options?: ProcessImageOptions,
): Promise<ProcessImageResult> {
  const autoResizeImages = options?.autoResizeImages ?? true;

  if (autoResizeImages) {
    const resized = await resizeImage(bytes, mimeType, options?.resizeOptions);
    if (!resized) {
      return {
        ok: false,
        message:
          "[Image omitted: invalid or unsupported image, or could not be resized below the inline image size limit.]",
      };
    }

    const hints: string[] = resized.animated ? ["[Animated image: only the first frame is sent.]"] : [];
    const convertedHint = conversionHint(resized.originalMimeType, resized.mimeType);
    if (convertedHint) hints.push(convertedHint);
    const dimensionNote = formatDimensionNote(resized);
    if (dimensionNote) hints.push(dimensionNote);

    return {
      ok: true,
      data: resized.data,
      mimeType: resized.mimeType,
      hints,
    };
  }

  const normalized = await normalizeImage(bytes);
  if (!normalized) {
    return {
      ok: false,
      message: "[Image omitted: could not be converted to a supported inline image format.]",
    };
  }
  const hints: string[] = normalized.animated ? ["[Animated image: only the first frame is sent.]"] : [];
  const convertedHint = conversionHint(normalized.convertedFrom, normalized.mimeType);
  if (convertedHint) hints.push(convertedHint);

  return {
    ok: true,
    data: Buffer.from(normalized.bytes).toString("base64"),
    mimeType: normalized.mimeType,
    hints,
  };
}
