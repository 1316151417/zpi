import sharp, { type Sharp } from "sharp";
import { imageLimits, READ_IMAGE_MAX_DIMENSION } from "../../../image-limits.ts";
import { fitsImageBudget, ImageProcessorError, imageBudget } from "./image-budget.ts";
import { imageFormat, openImage } from "./image-source.ts";

export interface ImageResizeOptions {
  maxWidth?: number;
  maxHeight?: number;
  /** Encoded base64 bytes, excluding the data URL prefix. Attachments default to 5 MiB. */
  maxBytes?: number;
  maxRawBytes?: number;
  /** Image input tokens, never the model's output limit. Omitted deliberately for user attachments. */
  maxTokens?: number;
  tokenToBase64CharRatio?: number;
  /** Optional stricter starting quality; the default ladder is 80, 60, 40, 20. */
  jpegQuality?: number;
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
  strategy: "original" | "png-optimized" | "preserve-format" | "resized" | "jpeg-quality" | "jpeg-fallback";
}
type ImageDimensions = { width: number; height: number };
const JPEG_QUALITY_STEPS = [80, 60, 40, 20];
const PROGRESSIVE_SCALE_FACTORS = [0.75, 0.5, 0.25];
const AGGRESSIVE_JPEG_MAX_EDGES = [1000, 800, 600, 400, 300, 200];
const MIN_IMAGE_EDGE = 1;

async function materializePixels(pipeline: Sharp) {
  const { data, info } = await pipeline.raw().toBuffer({ resolveWithObject: true });
  return {
    width: info.width,
    height: info.height,
    pipeline: sharp(data, {
      raw: { width: info.width, height: info.height, channels: info.channels },
      limitInputPixels: imageLimits.pixels,
    }),
  };
}

/** First fitting candidate wins. Compression can reach quality 20 / 200px: small text may be unreadable. */
export async function resizeImageInProcess(
  inputBytes: Uint8Array,
  mimeType: string,
  options?: ImageResizeOptions,
  autoResizeImages = true,
): Promise<ResizedImage> {
  const budget = imageBudget(options);
  const maxWidth = options?.maxWidth ?? READ_IMAGE_MAX_DIMENSION;
  const maxHeight = options?.maxHeight ?? READ_IMAGE_MAX_DIMENSION;
  const quality = options?.jpegQuality ?? 80;
  if (
    ![maxWidth, maxHeight, budget.maxRawBytes, budget.maxBase64Bytes, quality].every(
      (value) => Number.isSafeInteger(value) && value > 0,
    ) ||
    quality > 100 ||
    (budget.maxTokens !== undefined && (!Number.isFinite(budget.maxTokens) || budget.maxTokens < 0)) ||
    !Number.isFinite(budget.tokenToBase64CharRatio) ||
    budget.tokenToBase64CharRatio <= 0
  )
    throw new ImageProcessorError("invalid_request", "Invalid image budget or dimensions");
  if (!inputBytes.length) throw new ImageProcessorError("empty", "Image file is empty (0 bytes)");
  const format = imageFormat(inputBytes);
  const sourceMime = format ? `image/${format}` : mimeType;
  // Preserve the existing WebP budget-only passthrough policy independently of encoder capabilities.
  if (sourceMime === "image/webp") {
    if (!fitsImageBudget(inputBytes, budget))
      throw new ImageProcessorError(
        "unsupported",
        "WebP image exceeds the model image budget; the passthrough policy does not transcode WebP",
      );
    return {
      data: Buffer.from(inputBytes).toString("base64"),
      mimeType: sourceMime,
      originalMimeType: sourceMime,
      originalWidth: 0,
      originalHeight: 0,
      width: 0,
      height: 0,
      wasResized: false,
      strategy: "original",
    };
  }
  let image: Awaited<ReturnType<typeof materializePixels>>;
  let animated: boolean;
  try {
    const source = await openImage(inputBytes);
    // Fully decode one oriented frame once, then reuse its pixels for every candidate.
    // This also validates fitting originals and PNGs with trailing bytes.
    image = await materializePixels(source.pipeline.rotate().ensureAlpha());
    animated = source.animated;
  } catch {
    throw new ImageProcessorError("processing_failed", "Unable to decode image data");
  }
  const originalWidth = image.width;
  const originalHeight = image.height;
  const result = (
    data: Uint8Array,
    outputMime: string,
    candidate: ImageDimensions,
    strategy: ResizedImage["strategy"],
  ): ResizedImage => ({
    data: Buffer.from(data).toString("base64"),
    mimeType: outputMime,
    originalMimeType: sourceMime,
    originalWidth,
    originalHeight,
    width: candidate.width,
    height: candidate.height,
    wasResized: candidate.width !== originalWidth || candidate.height !== originalHeight,
    animated: animated && strategy !== "original",
    strategy,
  });
  const withinDimensions = originalWidth <= maxWidth && originalHeight <= maxHeight;
  if (withinDimensions && fitsImageBudget(inputBytes, budget) && sourceMime !== "image/bmp")
    return result(inputBytes, sourceMime, image, "original");
  const resize = (source: ImageDimensions, edge: number): ImageDimensions => {
    const scale = Math.min(1, edge / Math.max(source.width, source.height));
    return {
      width: Math.max(MIN_IMAGE_EDGE, Math.round(source.width * scale)),
      height: Math.max(MIN_IMAGE_EDGE, Math.round(source.height * scale)),
    };
  };
  const candidatePipeline = (candidate: ImageDimensions): Sharp => {
    const output = image.pipeline.clone();
    if (candidate.width !== originalWidth || candidate.height !== originalHeight)
      output.resize({
        width: candidate.width,
        height: candidate.height,
        fit: "fill",
        kernel: sharp.kernel.cubic,
      });
    return output;
  };
  // Keep only the current JPEG pixels, reusing resize/flatten work across quality attempts.
  let jpegPixels: typeof image | undefined;
  const encode = async (
    candidate: ImageDimensions,
    outputMime: string,
    strategy: ResizedImage["strategy"],
    jpegQuality?: number,
  ) => {
    let output: Sharp;
    // Preserve black JPEG backgrounds and first-frame GIF output. Codec bytes may differ from ZCode.
    if (outputMime === "image/jpeg") {
      if (jpegPixels?.width !== candidate.width || jpegPixels.height !== candidate.height)
        jpegPixels = await materializePixels(candidatePipeline(candidate).flatten({ background: "#000000" }));
      output = jpegPixels.pipeline.clone().jpeg({ quality: jpegQuality ?? 100 });
    } else {
      output = candidatePipeline(candidate);
      if (outputMime === "image/gif") output.gif();
      else output.png({ compressionLevel: 9, adaptiveFiltering: true });
    }
    const data = await output.toBuffer();
    return fitsImageBudget(data, budget) ? result(data, outputMime, candidate, strategy) : undefined;
  };
  if (!autoResizeImages) {
    // Disabling automatic compression never disables request limits. BMP still needs
    // format normalization, but neither resampling nor lossy fallback is allowed.
    if (withinDimensions && sourceMime === "image/bmp") {
      const fitted = await encode(image, "image/png", "preserve-format");
      if (fitted) return fitted;
    }
    throw new ImageProcessorError(
      "too_large",
      "Image exceeds the inline image limits; automatic resizing is disabled",
    );
  }
  const jpeg = async (candidate: ImageDimensions) => {
    for (const step of [quality, ...JPEG_QUALITY_STEPS.filter((step) => step < quality)]) {
      const fitted = await encode(candidate, "image/jpeg", "jpeg-quality", step);
      if (fitted) return fitted;
    }
    return undefined;
  };
  const preserve = async (candidate: ImageDimensions) =>
    sourceMime === "image/jpeg"
      ? jpeg(candidate)
      : encode(
          candidate,
          sourceMime === "image/gif" ? "image/gif" : "image/png",
          sourceMime === "image/gif" ? "preserve-format" : "png-optimized",
        );
  if (withinDimensions) {
    const fitted = await preserve(image);
    if (fitted) return fitted;
  }
  const boundedEdge = Math.max(
    1,
    Math.round(
      Math.max(originalWidth, originalHeight) *
        Math.min(1, maxWidth / originalWidth, maxHeight / originalHeight),
    ),
  );
  const bounded = resize(image, boundedEdge);
  // PNG gets one original-size lossless attempt, never a resized PNG candidate.
  const preserveSourceFormatAfterInitialAttempt = sourceMime !== "image/png";
  if (
    preserveSourceFormatAfterInitialAttempt &&
    (bounded.width !== originalWidth || bounded.height !== originalHeight)
  ) {
    const fitted = await encode(
      bounded,
      sourceMime === "image/gif" ? "image/gif" : sourceMime === "image/jpeg" ? "image/jpeg" : "image/png",
      "resized",
    );
    if (fitted) return fitted;
  }
  if (!withinDimensions && preserveSourceFormatAfterInitialAttempt) {
    const fitted = await preserve(bounded);
    if (fitted) return fitted;
  }
  const fitted = await jpeg(bounded);
  if (fitted) return fitted;
  // Non-cumulative scales relative to bounded; fallback edges below may be larger again.
  for (const scale of PROGRESSIVE_SCALE_FACTORS) {
    const scaled = resize(
      bounded,
      Math.max(MIN_IMAGE_EDGE, Math.round(Math.max(bounded.width, bounded.height) * scale)),
    );
    if (preserveSourceFormatAfterInitialAttempt) {
      const fitted = await preserve(scaled);
      if (fitted) return fitted;
    }
    const fitted = await jpeg(scaled);
    if (fitted) return fitted;
  }
  for (const edge of AGGRESSIVE_JPEG_MAX_EDGES) {
    const fitted = await encode(
      resize(image, Math.min(edge, boundedEdge)),
      "image/jpeg",
      "jpeg-fallback",
      20,
    );
    if (fitted) return fitted;
  }
  throw new ImageProcessorError(
    "too_large",
    `Unable to compress image (${inputBytes.byteLength} bytes) within the requested model image budget`,
  );
}
