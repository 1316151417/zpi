import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { contentText } from "@zpi-dev/ai";
import {
  createBashTool,
  createCodingTools,
  type ToolContext,
  type ToolDefinition,
} from "@zpi-dev/coding-agent";
import { type TObject, Type } from "typebox";
import { defineTool } from "./define-tool.ts";
import type { Tasks } from "./tasks.ts";
import type { Options } from "./types.ts";

const text = (value: string) => ({ content: [{ type: "text" as const, text: value }], details: undefined });
export function canonicalTools(
  cwd: string,
  outputDir: string,
  context: () => ToolContext,
  options: Options,
  tasks: Tasks,
): ToolDefinition<TObject>[] {
  const tools = new Map(
    createCodingTools(
      cwd,
      options.enableFileCheckpointing ? outputDir : undefined,
      () => context().model,
      context,
    ).map((tool) => [tool.name, tool]),
  );
  tools.set(
    "bash",
    createBashTool(
      cwd,
      {
        exposeSessionEnvironment: false,
        ...(options.env ? { spawnHook: (input) => ({ ...input, env: { ...options.env } }) } : {}),
      },
      context,
    ),
  );
  const call = (
    name: string,
    id: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
    update?: Parameters<ToolDefinition["execute"]>[3],
  ) => {
    const tool = tools.get(name);
    if (!tool) throw new Error(`Unknown native tool: ${name}`);
    return tool.execute(id, args, signal, update);
  };
  return [
    {
      name: "Read",
      label: "Read",
      description: "Read a file's text or supported image content. Use before editing a file.",
      metadata: { readOnly: true, concurrentSafe: true },
      parameters: Type.Object({
        file_path: Type.String(),
        offset: Type.Optional(Type.Integer({ minimum: 1 })),
        limit: Type.Optional(Type.Integer({ minimum: 1 })),
      }),
      execute: (id, input, signal, update) =>
        call("read", id, { path: input.file_path, offset: input.offset, limit: input.limit }, signal, update),
    },
    {
      name: "Write",
      label: "Write",
      description: "Write a UTF-8 file, creating its parent directories as needed.",
      parameters: Type.Object({ file_path: Type.String(), content: Type.String() }),
      execute: (id, input, signal, update) =>
        call("write", id, { path: input.file_path, content: input.content }, signal, update),
    },
    {
      name: "Edit",
      label: "Edit",
      description:
        "Replace an exact string in an existing file. The old string must be unique unless replace_all is true.",
      parameters: Type.Object({
        file_path: Type.String(),
        old_string: Type.String({ minLength: 1 }),
        new_string: Type.String(),
        replace_all: Type.Optional(Type.Boolean()),
      }),
      execute: async (id, input, signal, update) => {
        let oldText = input.old_string as string,
          newText = input.new_string as string;
        if (input.replace_all) {
          const source = await readFile(resolve(cwd, input.file_path as string), "utf8");
          if (!source.includes(oldText)) throw new Error("old_string was not found");
          newText = source.split(oldText).join(newText);
          oldText = source;
        }
        return call("edit", id, { path: input.file_path, edits: [{ oldText, newText }] }, signal, update);
      },
    },
    {
      name: "Bash",
      label: "Bash",
      description:
        "Run a shell command. timeout is in milliseconds. Background commands return a task ID for TaskOutput and TaskStop.",
      parameters: Type.Object({
        command: Type.String(),
        timeout: Type.Optional(Type.Integer({ minimum: 1, maximum: 600000 })),
        description: Type.Optional(Type.String()),
        run_in_background: Type.Optional(Type.Boolean()),
      }),
      execute: async (id, input, signal, update) => {
        const args = {
          command: input.command,
          ...(input.timeout !== undefined ? { timeout: Number(input.timeout) / 1000 } : {}),
        };
        if (input.run_in_background)
          return text(
            JSON.stringify({
              task_id: tasks.start(
                async (taskSignal, progress) => {
                  const result = await call("bash", id, args, taskSignal, (partial) =>
                    progress(contentText(partial.content)),
                  );
                  return contentText(result.content);
                },
                {
                  toolUseId: id,
                  description: String(input.description ?? input.command),
                  taskType: "local_bash",
                },
              ),
            }),
          );
        return call("bash", id, args, signal, update);
      },
    },
    // 暂不支持，预留以后实现。
    defineTool({
      name: "Glob",
      description: "Currently unsupported; reserved for future glob file search.",
      metadata: { readOnly: true, concurrentSafe: true },
      parameters: Type.Object({ pattern: Type.String(), path: Type.Optional(Type.String()) }),
      execute() {
        throw new Error("暂不支持");
      },
    }),
    // 暂不支持，预留以后实现。
    defineTool({
      name: "Grep",
      description: "Currently unsupported; reserved for future file content search.",
      metadata: { readOnly: true, concurrentSafe: true },
      parameters: Type.Object({
        pattern: Type.String(),
        path: Type.Optional(Type.String()),
        glob: Type.Optional(Type.String()),
        type: Type.Optional(Type.String()),
        output_mode: Type.Optional(
          Type.Union([Type.Literal("content"), Type.Literal("files_with_matches"), Type.Literal("count")]),
        ),
        "-i": Type.Optional(Type.Boolean()),
        "-n": Type.Optional(Type.Boolean()),
        "-A": Type.Optional(Type.Integer({ minimum: 0 })),
        "-B": Type.Optional(Type.Integer({ minimum: 0 })),
        "-C": Type.Optional(Type.Integer({ minimum: 0 })),
        context: Type.Optional(Type.Integer({ minimum: 0 })),
        multiline: Type.Optional(Type.Boolean()),
        head_limit: Type.Optional(Type.Integer({ minimum: 0 })),
        offset: Type.Optional(Type.Integer({ minimum: 0 })),
      }),
      execute() {
        throw new Error("暂不支持");
      },
    }),
    ...tasks.tools(),
  ];
}
