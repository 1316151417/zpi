import { Jimp, JimpMime, ResizeStrategy } from "jimp";
import { READ_IMAGE_MAX_DIMENSION } from "../../../image-limits.ts";
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
type DecodedImage = Awaited<ReturnType<typeof Jimp.read>>;
const JPEG_QUALITY_STEPS = [80, 60, 40, 20];
const PROGRESSIVE_SCALE_FACTORS = [0.75, 0.5, 0.25];
const AGGRESSIVE_JPEG_MAX_EDGES = [1000, 800, 600, 400, 300, 200];
const MIN_IMAGE_EDGE = 1;

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
  const sourceMime = imageFormat(inputBytes) ? `image/${imageFormat(inputBytes)}` : mimeType;
  // ZCode's WebP adapter does not decode, validate dimensions, strip metadata, or enforce 2000px.
  if (sourceMime === "image/webp") {
    if (!fitsImageBudget(inputBytes, budget))
      throw new ImageProcessorError(
        "unsupported",
        "WebP image exceeds the model image budget and the current image adapter cannot transcode WebP",
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
  let image: DecodedImage;
  let animated: boolean;
  try {
    const source = await openImage(inputBytes);
    await source.pipeline.stats();
    animated = source.animated;
    const decodeWithSharp = async () => {
      const { data, info } = await source.pipeline.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      return Jimp.fromBitmap({ data, width: info.width, height: info.height });
    };
    // Retain ZPI's guarded BMP decoder (including RLE/bitfields unsupported by Jimp).
    if (sourceMime === "image/bmp" || (sourceMime === "image/png" && source.animated))
      image = await decodeWithSharp();
    else {
      try {
        image = await Jimp.read(Buffer.from(inputBytes));
      } catch (error) {
        // PNG decoders differ on trailing bytes. Sharp already validated the complete
        // first frame above; feed its pixels to the same Jimp encoding ladder.
        if (sourceMime !== "image/png") throw error;
        image = await decodeWithSharp();
      }
    }
  } catch {
    throw new ImageProcessorError("processing_failed", "Unable to decode image data");
  }
  const originalWidth = image.bitmap.width;
  const originalHeight = image.bitmap.height;
  const result = (
    data: Uint8Array,
    outputMime: string,
    candidate: DecodedImage,
    strategy: ResizedImage["strategy"],
  ): ResizedImage => ({
    data: Buffer.from(data).toString("base64"),
    mimeType: outputMime,
    originalMimeType: sourceMime,
    originalWidth,
    originalHeight,
    width: candidate.bitmap.width,
    height: candidate.bitmap.height,
    wasResized: candidate.bitmap.width !== originalWidth || candidate.bitmap.height !== originalHeight,
    animated: animated && strategy !== "original",
    strategy,
  });
  const withinDimensions = originalWidth <= maxWidth && originalHeight <= maxHeight;
  if (withinDimensions && fitsImageBudget(inputBytes, budget) && sourceMime !== "image/bmp")
    return result(inputBytes, sourceMime, image, "original");
  const resize = (source: DecodedImage, edge: number): DecodedImage => {
    const clone = source.clone();
    if (Math.max(clone.bitmap.width, clone.bitmap.height) > edge)
      clone.scaleToFit({ w: edge, h: edge, mode: ResizeStrategy.BICUBIC });
    return clone;
  };
  const encode = async (
    candidate: DecodedImage,
    outputMime: string,
    strategy: ResizedImage["strategy"],
    jpegQuality?: number,
  ) => {
    // Jimp composites transparent pixels onto black for JPEG; GIF encoding quantizes the first frame.
    const data =
      outputMime === JimpMime.jpeg
        ? await candidate.getBuffer(JimpMime.jpeg, { quality: jpegQuality ?? 100 })
        : outputMime === JimpMime.gif
          ? await candidate.getBuffer(JimpMime.gif)
          : await candidate.getBuffer(JimpMime.png, { deflateLevel: 9, deflateStrategy: 3 });
    return fitsImageBudget(data, budget) ? result(data, outputMime, candidate, strategy) : undefined;
  };
  if (!autoResizeImages) {
    // Disabling automatic compression never disables request limits. BMP still needs
    // format normalization, but neither resampling nor lossy fallback is allowed.
    if (withinDimensions && sourceMime === "image/bmp") {
      const fitted = await encode(image, JimpMime.png, "preserve-format");
      if (fitted) return fitted;
    }
    throw new ImageProcessorError(
      "too_large",
      "Image exceeds the inline image limits; automatic resizing is disabled",
    );
  }
  const jpeg = async (candidate: DecodedImage) => {
    for (const step of [quality, ...JPEG_QUALITY_STEPS.filter((step) => step < quality)]) {
      const fitted = await encode(candidate, JimpMime.jpeg, "jpeg-quality", step);
      if (fitted) return fitted;
    }
    return undefined;
  };
  const preserve = async (candidate: DecodedImage) =>
    sourceMime === JimpMime.jpeg
      ? jpeg(candidate)
      : encode(
          candidate,
          sourceMime === JimpMime.gif ? JimpMime.gif : JimpMime.png,
          sourceMime === JimpMime.gif ? "preserve-format" : "png-optimized",
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
  const preserveSourceFormatAfterInitialAttempt = sourceMime !== JimpMime.png;
  if (
    preserveSourceFormatAfterInitialAttempt &&
    (bounded.bitmap.width !== originalWidth || bounded.bitmap.height !== originalHeight)
  ) {
    const fitted = await encode(
      bounded,
      sourceMime === JimpMime.gif
        ? JimpMime.gif
        : sourceMime === JimpMime.jpeg
          ? JimpMime.jpeg
          : JimpMime.png,
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
      Math.max(MIN_IMAGE_EDGE, Math.round(Math.max(bounded.bitmap.width, bounded.bitmap.height) * scale)),
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
      JimpMime.jpeg,
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
