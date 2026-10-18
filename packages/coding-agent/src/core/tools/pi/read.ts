// Adapted from Pi c20cb09772bf4e2590a316cb54514cef76df4293.
// Copyright (c) 2025 Mario Zechner. MIT license: THIRD_PARTY_NOTICES.md.

import { constants, createReadStream } from "node:fs";
import { access as fsAccess, readFile as fsReadFile } from "node:fs/promises";
import { Type } from "typebox";
import type { ImageContent, Model, TextContent } from "zpi-ai";
import { imageLimits } from "../../image-limits.ts";
import { readFileBounded } from "../../read-file-bounded.ts";
import type { ExtensionContext, ToolDefinition } from "./compat.ts";
import { FileReadState } from "./file-read-state.ts";
import { resolveReadPathAsync } from "./path-utils.ts";
import { readTextRange } from "./text-range-reader.ts";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, type TruncationResult } from "./truncate.ts";
import { fitsImageBudget, imageBudget, readImageResizeOptions } from "./utils/image-budget.ts";
import { processImage } from "./utils/image-process.ts";
import type { ImageResizeOptions as ModelImageResizeOptions } from "./utils/image-resize-core.ts";
import { detectSupportedImageMimeTypeFromFile } from "./utils/mime.ts";

const readSchema = Type.Object({
  path: Type.String({ description: "Path to the file to read (relative or absolute)" }),
  offset: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: Number.MAX_SAFE_INTEGER,
      description: "Line number to start reading from (1-indexed)",
    }),
  ),
  limit: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: Number.MAX_SAFE_INTEGER,
      description: "Maximum number of lines to read",
    }),
  ),
});

export const readToolSystemPromptContribution = {
  snippet: "Read file contents",
  guidelines: ["Use read to examine files instead of cat or sed."],
} as const;

export interface ReadToolDetails {
  truncation?: TruncationResult;
}

/**
 * Pluggable operations for the read tool.
 * Override these to delegate file reading to remote systems (for example SSH).
 */
export interface ReadOperations {
  /** Read file contents as a Buffer. Bound source I/O to maxBytes + 1 when a limit is supplied. */
  readFile: (absolutePath: string, maxBytes?: number) => Promise<Buffer>;
  /** Check if file is readable (throw if not) */
  access: (absolutePath: string) => Promise<void>;
  /** Detect image MIME type, return null or undefined for non-images */
  detectImageMimeType?: (absolutePath: string) => Promise<string | null | undefined>;
}

const defaultReadOperations: ReadOperations = {
  readFile: (path, maxBytes) => (maxBytes === undefined ? fsReadFile(path) : readFileBounded(path, maxBytes)),
  access: (path) => fsAccess(path, constants.R_OK),
  detectImageMimeType: detectSupportedImageMimeTypeFromFile,
};

export interface ReadToolOptions {
  /** Shared knowledge of file contents in the current model context. */
  fileReadState?: FileReadState;
  /** Whether to auto-resize images. Default: true */
  autoResizeImages?: boolean;
  /** Fallback resize profile when the execution context has no model metadata. */
  resizeOptions?: ModelImageResizeOptions;
  /** Custom operations for file reading. Default: local filesystem */
  operations?: ReadOperations;
}

function getNonVisionImageNote(model: Model | undefined): string | undefined {
  if (!model || model.input.includes("image")) {
    return undefined;
  }
  return "[Current model does not support images. The image will be omitted from this request.]";
}

export function createReadToolDefinition(
  cwd: string,
  options?: ReadToolOptions,
): ToolDefinition<typeof readSchema, ReadToolDetails | undefined> {
  const autoResizeImages = options?.autoResizeImages ?? true;
  const fallbackResizeOptions = options?.resizeOptions;
  const ops = options?.operations ?? defaultReadOperations;
  const fileReadState = options?.fileReadState ?? new FileReadState();
  return {
    name: "read",
    metadata: {
      readOnly: true,
      concurrentSafe: true,
      destructive: false,
      needsApproval: false,
      requiresUserInteraction: false,
      sideEffectScope: "none",
    },
    label: "read",
    description: `Read the contents of a file. Supports text files and images (jpg, png, gif, webp, bmp). Images up to 20 MiB are sent as attachments. For text files, output is truncated to ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). Use offset/limit for large files. When you need the full file, continue with offset until complete.`,
    promptSnippet: readToolSystemPromptContribution.snippet,
    promptGuidelines: [...readToolSystemPromptContribution.guidelines],
    parameters: readSchema,
    async execute(
      _toolCallId,
      { path, offset, limit }: { path: string; offset?: number; limit?: number },
      signal?: AbortSignal,
      _onUpdate?,
      ctx?: ExtensionContext,
    ) {
      // SDK callers can execute tools directly without the agent's schema validation.
      for (const [name, value] of Object.entries({ offset, limit })) {
        if (value !== undefined && (!Number.isSafeInteger(value) || value < 1))
          throw new Error(`${name} must be a positive integer`);
      }
      return new Promise<{ content: (TextContent | ImageContent)[]; details: ReadToolDetails | undefined }>(
        (resolve, reject) => {
          if (signal?.aborted) {
            reject(new Error("Operation aborted"));
            return;
          }
          let aborted = false;
          const onAbort = () => {
            aborted = true;
            reject(new Error("Operation aborted"));
          };
          signal?.addEventListener("abort", onAbort, { once: true });

          (async () => {
            try {
              const absolutePath = await resolveReadPathAsync(path, ctx?.cwd || cwd);
              if (aborted) return;
              // Check if file exists and is readable.
              await ops.access(absolutePath);
              if (aborted) return;
              const mimeType = ops.detectImageMimeType
                ? await ops.detectImageMimeType(absolutePath)
                : undefined;
              if (aborted) return;
              let content: (TextContent | ImageContent)[];
              let details: ReadToolDetails | undefined;
              const nonVisionImageNote = getNonVisionImageNote(ctx?.model);
              if (mimeType) {
                // Read image as binary.
                const buffer = await ops.readFile(absolutePath, imageLimits.readSourceBytes);
                // Older/custom readers may ignore the optional I/O limit. Never decode oversized results.
                if (buffer.length > imageLimits.readSourceBytes)
                  throw new Error(`Image exceeds the ${imageLimits.readSourceBytes} byte size limit`);
                let processed = await processImage(buffer, mimeType, {
                  autoResizeImages,
                  resizeOptions: readImageResizeOptions(
                    ctx?.model?.inputLimits?.images?.resize ?? fallbackResizeOptions,
                  ),
                });
                // Defensive check for replacement adapters: never send an over-budget Read result.
                if (
                  processed.ok &&
                  !fitsImageBudget(
                    Buffer.from(processed.data, "base64"),
                    imageBudget(
                      readImageResizeOptions(
                        ctx?.model?.inputLimits?.images?.resize ?? fallbackResizeOptions,
                      ),
                    ),
                  )
                )
                  processed = {
                    ok: false,
                    code: "read_image_budget_exceeded",
                    message: "[Image omitted: read_image_budget_exceeded.]",
                  };
                if (!processed.ok) {
                  let textNote = `Read image file [${mimeType}]\n${processed.message}`;
                  if (nonVisionImageNote) textNote += `\n${nonVisionImageNote}`;
                  content = [{ type: "text", text: textNote }];
                } else {
                  let textNote = `Read image file [${processed.mimeType}]`;
                  if (processed.hints.length > 0) textNote += `\n${processed.hints.join("\n")}`;
                  if (nonVisionImageNote) textNote += `\n${nonVisionImageNote}`;
                  content = [
                    { type: "text", text: textNote },
                    { type: "image", data: processed.data, mimeType: processed.mimeType },
                  ];
                }
              } else {
                // Local text is streamed, including giant lines. Custom readers retain
                // their buffer-based contract and may refer to non-local paths.
                const chunks = options?.operations
                  ? [(await ops.readFile(absolutePath)).toString("utf8")]
                  : createReadStream(absolutePath, { encoding: "utf8", signal });
                if (aborted) return;
                const { hash, totalFileLines, firstLineBytes, truncation } = await readTextRange(
                  chunks,
                  offset,
                  limit,
                );
                if (aborted) return;
                // Apply offset if specified. Convert from 1-indexed input to 0-indexed array access.
                const startLine = offset === undefined ? 0 : offset - 1;
                const startLineDisplay = startLine + 1;
                // Check if offset is out of bounds.
                if (startLine >= totalFileLines && (offset !== undefined || totalFileLines > 0)) {
                  throw new Error(`Offset ${offset} is beyond end of file (${totalFileLines} lines total)`);
                }
                if (fileReadState.isHashUnchanged(absolutePath, hash, offset, limit)) {
                  signal?.removeEventListener("abort", onAbort);
                  resolve({
                    content: [
                      {
                        type: "text",
                        text: "File unchanged. Reuse the file content already in context from your earlier read or successful edit/write.",
                      },
                    ],
                    details: undefined,
                  });
                  return;
                }
                const userLimitedLines =
                  limit === undefined ? undefined : Math.min(limit, totalFileLines - startLine);
                let outputText: string;
                if (truncation.firstLineExceedsLimit) {
                  // First line alone exceeds the byte limit. Point the model at a bash fallback.
                  const firstLineSize = formatSize(firstLineBytes);
                  outputText = `[Line ${startLineDisplay} is ${firstLineSize}, exceeds ${formatSize(DEFAULT_MAX_BYTES)} limit. Use bash: sed -n '${startLineDisplay}p' ${path} | head -c ${DEFAULT_MAX_BYTES}]`;
                  details = { truncation };
                } else if (truncation.truncated) {
                  // Truncation occurred. Build an actionable continuation notice.
                  const endLineDisplay = startLineDisplay + truncation.outputLines - 1;
                  const nextOffset = endLineDisplay + 1;
                  outputText = truncation.content;
                  if (truncation.truncatedBy === "lines") {
                    outputText += `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines}. Use offset=${nextOffset} to continue.]`;
                  } else {
                    outputText += `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). Use offset=${nextOffset} to continue.]`;
                  }
                  details = { truncation };
                } else if (userLimitedLines !== undefined && startLine + userLimitedLines < totalFileLines) {
                  // User-specified limit stopped early, but the file still has more content.
                  const remaining = totalFileLines - (startLine + userLimitedLines);
                  const nextOffset = startLine + userLimitedLines + 1;
                  outputText = `${truncation.content}\n\n[${remaining} more lines in file. Use offset=${nextOffset} to continue.]`;
                } else {
                  // No truncation and no remaining user-limited content.
                  outputText = truncation.content;
                }
                content = [{ type: "text", text: outputText }];
                fileReadState.recordReadHash(absolutePath, hash, offset, limit, truncation.truncated);
              }

              if (aborted) return;
              signal?.removeEventListener("abort", onAbort);
              resolve({ content, details });
            } catch (error: unknown) {
              signal?.removeEventListener("abort", onAbort);
              if (!aborted) reject(error);
            }
          })();
        },
      );
    },
  };
}
