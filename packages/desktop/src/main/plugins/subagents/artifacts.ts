// Local agent output and resultBudget behavior follow ZCode (Apache-2.0).
import { createHash } from "node:crypto";
import { mkdir, open, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { JsonValue } from "zpi-ai";
import type { SubagentTask } from "zpi-ui";
import {
  completedAgentOutput,
  formatCompactFileSize,
  formatGenericPersistedOutputContent,
  formatPersistedOutputEnvelope,
  providerTaskStatus,
} from "./protocol.ts";

export const textResult = (text: string, output?: unknown, isError = false) => ({
  content: [{ type: "text" as const, text }],
  details: output === undefined ? undefined : (JSON.parse(JSON.stringify(output)) as JsonValue),
  ...(isError ? { isError: true } : {}),
});

export class SubagentArtifacts {
  readonly root: string;
  constructor(root: string) {
    this.root = root;
  }
  paths(parentId: string, agentId: string) {
    const dir = join(this.root, parentId, agentId);
    return {
      outputFile: join(dir, "output.txt"),
      taskOutputFile: join(dir, "task.output"),
      metadataFile: join(dir, "metadata.json"),
    };
  }
  async metadata(task: SubagentTask, profile?: unknown) {
    if (!task.metadataFile) return;
    await mkdir(dirname(task.metadataFile), { recursive: true });
    let previous: { profileSnapshot?: unknown } = {};
    try {
      previous = JSON.parse(await readFile(task.metadataFile, "utf8"));
    } catch {}
    await writeFile(
      task.metadataFile,
      `${JSON.stringify(
        {
          agentId: task.agentId,
          childSessionId: task.childSessionId,
          createdAt: new Date(task.startedAt).toISOString(),
          cwd: task.cwd,
          description: task.description,
          metadataFile: task.metadataFile,
          outputFile: task.outputFile,
          parentSessionId: task.parentSessionId,
          parentToolUseId: task.parentToolCallId,
          profileId: task.agentType,
          profileSnapshot: profile ?? previous.profileSnapshot,
          prompt: task.prompt ?? "",
          status:
            task.status === "aborted" || task.status === "interrupted" ? "stopped" : providerTaskStatus(task),
          taskOutputFile: task.taskOutputFile,
          updatedAt: new Date().toISOString(),
          workspaceRoot: task.cwd,
          ...(task.error ? { error: task.error } : {}),
          ...(task.endedAt === undefined
            ? {}
            : {
                completedAt: new Date(task.endedAt).toISOString(),
                ...(task.status === "completed"
                  ? {
                      totalDurationMs: Math.max(0, task.endedAt - task.startedAt),
                      totalToolUseCount: task.totalToolUseCount,
                    }
                  : {}),
              }),
          ...(task.status === "completed" && task.tokensReported ? { totalTokens: task.totalTokens } : {}),
          ...(task.status === "completed" && task.usage ? { usage: task.usage } : {}),
        },
        null,
        2,
      )}\n`,
      { mode: 0o600 },
    );
  }
  async finish(task: SubagentTask) {
    const content =
      task.status === "completed"
        ? completedAgentOutput(task)
            .content.map((part) => part.text)
            .join("\n\n")
        : task.status === "aborted"
          ? "Background agent task stopped.\n"
          : (task.error ?? "");
    for (const path of [task.outputFile, task.taskOutputFile]) {
      if (!path) continue;
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, content, { mode: 0o600 });
    }
    await this.metadata(task);
  }
  async read(outputFile: string | undefined, signal?: AbortSignal): Promise<string> {
    if (!outputFile) return "";
    signal?.throwIfAborted();
    try {
      const handle = await open(outputFile, "r");
      try {
        const size = (await handle.stat()).size;
        const buffer = Buffer.allocUnsafe(Math.min(size, 8 * 1024 * 1024));
        const start = size - buffer.length;
        let bytesRead = 0;
        while (bytesRead < buffer.length) {
          const result = await handle.read(buffer, bytesRead, buffer.length - bytesRead, start + bytesRead);
          if (!result.bytesRead) break;
          bytesRead += result.bytesRead;
        }
        signal?.throwIfAborted();
        const content = buffer.subarray(0, bytesRead).toString("utf8");
        return size > bytesRead
          ? `[${Math.round((size - bytesRead) / 1024)}KB of earlier output omitted]\n${content}`
          : content;
      } finally {
        await handle.close();
      }
    } catch (error) {
      signal?.throwIfAborted();
      if (error instanceof Error && error.name === "AbortError") throw error;
      return "";
    }
  }
  async result(parentId: string, callId: string, name: string, text: string, output?: unknown) {
    const limit =
      name === "Agent" ? 120000 : name === "TaskOutput" ? 400000 : name === "TaskStop" ? 100000 : 4096;
    const originalBytes = Buffer.byteLength(text, "utf8");
    const characterBudget = name === "TaskOutput" && text.length > 100000;
    if (originalBytes <= limit && !characterBudget) return textResult(text, output);
    const artifact = name === "Agent" || name === "TaskOutput";
    if (artifact) {
      // IDs supplied by model providers are not filesystem paths.
      const key = createHash("sha256").update(callId).digest("hex");
      const path = join(this.root, parentId, "tool-results", `${name}-${key}.txt`);
      try {
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, text, { mode: 0o600 });
        return textResult(
          name === "TaskOutput"
            ? formatPersistedOutputEnvelope({
                content: text,
                formatBytes: formatCompactFileSize,
                originalBytes: text.length,
                persistedPath: path,
                previewChars: 2000,
              })
            : formatGenericPersistedOutputContent({ content: text, originalBytes, persistedPath: path }),
          output,
        );
      } catch {
        if (characterBudget) return textResult(text, output);
      }
    }
    const suffix = `\n\n[Tool output truncated by resultBudget: originalBytes=${originalBytes}, maxModelBytes=${limit}, strategy=${artifact ? "artifact" : "truncate"}]`;
    const bytes = Buffer.from(text);
    let prefix = bytes.subarray(0, Math.max(0, limit - Buffer.byteLength(suffix))).toString("utf8");
    if (prefix.endsWith("\uFFFD")) prefix = prefix.slice(0, -1);
    return textResult(`${prefix}${suffix}`, output);
  }
}
