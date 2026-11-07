import { execFile } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { promisify } from "node:util";
import { type TObject, Type } from "typebox";
import { contentText } from "zpi-ai";
import { createBashTool, createCodingTools, type ToolContext, type ToolDefinition } from "zpi-coding-agent";
import type { Tasks } from "./tasks.ts";
import type { Options } from "./types.ts";

const text = (value: string) => ({ content: [{ type: "text" as const, text: value }], details: undefined });
const executeFile = promisify(execFile);
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
              task_id: tasks.start(async (taskSignal) => {
                const result = await call("bash", id, args, taskSignal);
                return contentText(result.content);
              }),
            }),
          );
        return call("bash", id, args, signal, update);
      },
    },
    {
      name: "Glob",
      label: "Glob",
      description: "Find files by glob pattern under path (defaults to cwd). Returns up to 1000 paths.",
      metadata: { readOnly: true, concurrentSafe: true },
      parameters: Type.Object({ pattern: Type.String(), path: Type.Optional(Type.String()) }),
      execute: async (_id, input, signal) => {
        const root = resolve(cwd, String(input.path ?? "."));
        const { matchesGlob } = await import("node:path");
        const found: { path: string; mtime: number }[] = [];
        let entries = 0;
        const walk = async (directory: string, depth: number): Promise<void> => {
          signal?.throwIfAborted();
          if (depth > 32 || entries > 50000) return;
          for (const item of await readdir(directory, { withFileTypes: true })) {
            signal?.throwIfAborted();
            if (++entries > 50000) return;
            if ([".git", "node_modules"].includes(item.name)) continue;
            const path = resolve(directory, item.name);
            if (item.isDirectory()) await walk(path, depth + 1);
            else if (
              item.isFile() &&
              (matchesGlob(relative(root, path), String(input.pattern)) ||
                matchesGlob(path, String(input.pattern)))
            )
              found.push({ path, mtime: (await stat(path)).mtimeMs });
          }
        };
        await walk(root, 0);
        return text(
          found
            .sort((a, b) => b.mtime - a.mtime)
            .slice(0, 1000)
            .map((file) => file.path)
            .join("\n") || "No files found",
        );
      },
    },
    {
      name: "Grep",
      label: "Grep",
      description:
        "Search file content with ripgrep. output_mode is content, files_with_matches, or count. Regex syntax follows ripgrep.",
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
      execute: async (_id, input, signal) => {
        const args = ["--color", "never", "--no-heading", "--hidden", "-g", "!.git", "-g", "!node_modules"];
        const mode = input.output_mode ?? "files_with_matches";
        if (mode === "files_with_matches") args.push("--files-with-matches");
        else if (mode === "count") args.push("--count");
        else if (input["-n"] !== false) args.push("--line-number");
        if (input["-i"]) args.push("--ignore-case");
        if (input.multiline) args.push("--multiline", "--multiline-dotall");
        if (input.glob) args.push("--glob", String(input.glob));
        if (input.type) args.push("--type", String(input.type));
        for (const key of ["-A", "-B", "-C"] as const)
          if (input[key] !== undefined) args.push(key, String(input[key]));
        if (input.context !== undefined) args.push("-C", String(input.context));
        args.push("--", String(input.pattern), resolve(cwd, String(input.path ?? ".")));
        let output: string;
        try {
          output = (await executeFile("rg", args, { signal, cwd, maxBuffer: 4 * 1024 * 1024 })).stdout;
        } catch (error) {
          if ((error as { code?: unknown }).code === 1) return text("No matches found");
          if ((error as { code?: unknown }).code === "ENOENT")
            throw new Error("Grep requires ripgrep (rg) on PATH");
          throw error;
        }
        const lines = output.trimEnd().split("\n"),
          offset = Number(input.offset ?? 0),
          limit = Number(input.head_limit ?? 0);
        return text(lines.slice(offset, limit ? offset + limit : undefined).join("\n"));
      },
    },
    ...tasks.tools(),
  ];
}
