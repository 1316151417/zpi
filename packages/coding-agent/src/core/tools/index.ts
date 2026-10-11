import { createHash } from "node:crypto";
import { readFile, realpath, writeFile } from "node:fs/promises";
import type { AgentTool, AgentToolResult } from "zpi-agent";
import type { JsonValue, Model } from "zpi-ai";
import { beforeFile, type FileChange, recordFileChange } from "./file-change.ts";
import { type BashToolOptions, createBashToolDefinition } from "./pi/bash.ts";
import type { ExtensionContext, ToolDefinition } from "./pi/compat.ts";
import { createEditToolDefinition, type EditToolOptions } from "./pi/edit.ts";
import { createReadToolDefinition, type ReadToolOptions } from "./pi/read.ts";
import { wrapToolDefinition } from "./pi/tool-definition-wrapper.ts";
import { createWriteToolDefinition, type WriteToolOptions } from "./pi/write.ts";

export { createBashToolDefinition, createLocalBashOperations } from "./pi/bash.ts";
export { createEditToolDefinition } from "./pi/edit.ts";
export { createReadToolDefinition } from "./pi/read.ts";
export { createWriteToolDefinition } from "./pi/write.ts";
export type { BashToolOptions, EditToolOptions, ReadToolOptions, WriteToolOptions };
export type ToolContextFactory = () => ExtensionContext | undefined;

export function createReadTool(
  cwd: string,
  options?: ReadToolOptions | (() => Model),
  context?: ToolContextFactory,
): AgentTool {
  const getModel = typeof options === "function" ? options : undefined;
  const definition = createReadToolDefinition(cwd, typeof options === "function" ? undefined : options);
  return wrapToolDefinition(
    definition,
    context ?? (getModel ? () => ({ cwd, model: getModel() }) as ExtensionContext : undefined),
  );
}
export function createBashTool(
  cwd: string,
  options?: BashToolOptions,
  context?: ToolContextFactory,
): AgentTool {
  return wrapToolDefinition(createBashToolDefinition(cwd, options), context);
}

// File-change observation is outside the Pi tool semantics, but runs inside its mutation queue.
// It adds persisted UI facts without altering matching, filesystem operations, or model-facing success text.
function observeMutation(
  cwd: string,
  tool: "write" | "edit",
  options: WriteToolOptions | EditToolOptions | undefined,
  outputDir: string | undefined,
  context: ToolContextFactory | undefined,
): AgentTool {
  const base =
    tool === "write"
      ? createWriteToolDefinition(cwd, options as WriteToolOptions)
      : createEditToolDefinition(cwd, options as EditToolOptions);
  const wrapped = wrapToolDefinition(base as ToolDefinition<typeof base.parameters, unknown>, context);
  return {
    ...wrapped,
    execute: async (id, params, signal, update) => {
      if (options?.operations) return wrapped.execute(id, params as never, signal, update);
      let change: FileChange | undefined;
      let diagnostic = "";
      const observeWrite = async (path: string, content: string) => {
        const before = await beforeFile(path);
        let failure: unknown;
        try {
          await writeFile(path, content, "utf8");
        } catch (error) {
          failure = error;
        }
        try {
          change = await recordFileChange(
            await realpath(path).catch(() => path),
            id,
            before,
            outputDir,
            Boolean(failure),
          );
        } catch (error) {
          if (failure) diagnostic = `文件最终状态不可读，可能已修改；记录不可用: ${String(error)}`;
          else
            change = {
              path,
              operation: before === null ? "created" : "modified",
              toolCallId: id,
              beforeHash: before === null ? null : createHash("sha256").update(before).digest("hex"),
              afterHash: "unknown",
              reason: "文件已修改，但记录不可用",
            };
        }
        if (failure) throw failure;
      };
      const definition =
        tool === "write"
          ? createWriteToolDefinition(cwd, {
              operations: {
                writeFile: observeWrite,
                mkdir: async (path) => {
                  const { mkdir } = await import("node:fs/promises");
                  await mkdir(path, { recursive: true });
                },
              },
            })
          : createEditToolDefinition(cwd, {
              operations: {
                writeFile: observeWrite,
                readFile,
                access: async (path) => {
                  const { access, constants } = await import("node:fs/promises");
                  await access(path, constants.R_OK | constants.W_OK);
                },
              },
            });
      let result: AgentToolResult;
      try {
        result = await wrapToolDefinition(
          definition as ToolDefinition<typeof definition.parameters, unknown>,
          context,
        ).execute(id, params as never, signal, update);
      } catch (error) {
        if (!change && !diagnostic) throw error;
        result = {
          isError: true,
          content: [
            {
              type: "text",
              text: `${String(error)}${diagnostic ? `\n${diagnostic}` : "; file has changed."}`,
            },
          ],
          details: undefined,
        };
      }
      if (change)
        result.details = {
          ...(result.details as Record<string, JsonValue> | undefined),
          fileChange: { ...change, ...(result.isError ? { failed: true } : {}) },
        };
      return result;
    },
  };
}
export function createWriteTool(
  cwd: string,
  options?: WriteToolOptions | string,
  context?: ToolContextFactory,
): AgentTool {
  return observeMutation(
    cwd,
    "write",
    typeof options === "string" ? undefined : options,
    typeof options === "string" ? options : undefined,
    context,
  );
}
export function createEditTool(
  cwd: string,
  options?: EditToolOptions | string,
  context?: ToolContextFactory,
): AgentTool {
  return observeMutation(
    cwd,
    "edit",
    typeof options === "string" ? undefined : options,
    typeof options === "string" ? options : undefined,
    context,
  );
}
export function createCodingTools(
  cwd: string,
  outputDir?: string,
  getModel?: () => Model,
  context?: ToolContextFactory,
): AgentTool[] {
  return [
    createReadTool(cwd, getModel, context),
    createBashTool(cwd, undefined, context),
    createEditTool(cwd, outputDir, context),
    createWriteTool(cwd, outputDir, context),
  ];
}
