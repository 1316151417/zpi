import {
  READ_IMAGE_MAX_BASE64_BYTES,
  READ_IMAGE_MAX_DIMENSION,
  READ_IMAGE_TARGET_BYTES,
  READ_IMAGE_TOKEN_TO_BASE64_CHAR_RATIO,
  READ_MAX_OUTPUT_TOKENS,
} from "../../../image-limits.ts";
import type { ImageResizeOptions } from "./image-resize-core.ts";

export interface ImageBudget {
  maxRawBytes: number;
  maxBase64Bytes: number;
  maxTokens?: number;
  tokenToBase64CharRatio: number;
}

export function imageBudget(options?: ImageResizeOptions): ImageBudget {
  return {
    maxRawBytes: options?.maxRawBytes ?? READ_IMAGE_TARGET_BYTES,
    maxBase64Bytes: options?.maxBytes ?? READ_IMAGE_MAX_BASE64_BYTES,
    maxTokens: options?.maxTokens,
    tokenToBase64CharRatio: options?.tokenToBase64CharRatio ?? READ_IMAGE_TOKEN_TO_BASE64_CHAR_RATIO,
  };
}

export function fitsImageBudget(bytes: Uint8Array, budget: ImageBudget): boolean {
  const base64Bytes = Math.ceil(bytes.byteLength / 3) * 4;
  if (bytes.byteLength > budget.maxRawBytes) return false;
  if (base64Bytes > budget.maxBase64Bytes) return false;
  return (
    budget.maxTokens === undefined ||
    Math.ceil(base64Bytes * budget.tokenToBase64CharRatio) <= budget.maxTokens
  );
}

/** Model profiles can tighten Read's limits, never relax its independent 25K image-token budget. */
export function readImageResizeOptions(options?: ImageResizeOptions): ImageResizeOptions {
  return {
    ...options,
    jpegQuality: Math.min(options?.jpegQuality ?? 80, 80),
    maxWidth: Math.min(options?.maxWidth ?? READ_IMAGE_MAX_DIMENSION, READ_IMAGE_MAX_DIMENSION),
    maxHeight: Math.min(options?.maxHeight ?? READ_IMAGE_MAX_DIMENSION, READ_IMAGE_MAX_DIMENSION),
    maxBytes: Math.min(options?.maxBytes ?? READ_IMAGE_MAX_BASE64_BYTES, READ_IMAGE_MAX_BASE64_BYTES),
    maxRawBytes: Math.min(options?.maxRawBytes ?? READ_IMAGE_TARGET_BYTES, READ_IMAGE_TARGET_BYTES),
    maxTokens: Math.min(options?.maxTokens ?? READ_MAX_OUTPUT_TOKENS, READ_MAX_OUTPUT_TOKENS),
    tokenToBase64CharRatio: Math.max(
      options?.tokenToBase64CharRatio ?? READ_IMAGE_TOKEN_TO_BASE64_CHAR_RATIO,
      READ_IMAGE_TOKEN_TO_BASE64_CHAR_RATIO,
    ),
  };
}

export type ImageProcessorErrorCode =
  | "invalid_request"
  | "empty"
  | "processing_failed"
  | "too_large"
  | "unsupported";
export class ImageProcessorError extends Error {
  readonly code: ImageProcessorErrorCode;
  constructor(code: ImageProcessorErrorCode, message: string) {
    super(message);
    this.name = "ImageProcessorError";
    this.code = code;
  }
}
