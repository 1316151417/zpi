import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { SessionRecord } from "../../shared/bridge.ts";
import type { HistoryIndex } from "../history-index.ts";
import { memoryEvidence } from "../memory/evidence.ts";
import type { LongMemorySource } from "../memory/long-memory.ts";
import { sessionReferenceTranscriptReverse } from "../session-references.ts";

interface MemorySourcePorts {
  directory: string;
  records(): Iterable<SessionRecord>;
  index(id: string): Pick<HistoryIndex, "snapshot" | "readReverse">;
  cwd(record: SessionRecord): string;
  blocked(id: string): boolean;
  active(id: string): boolean;
  exists(id: string): boolean;
  deleting(id: string): boolean;
}

/** Adapts stable history snapshots to the memory pipeline's evidence protocol. */
export function memorySources(ports: MemorySourcePorts): LongMemorySource[] {
  return [...ports.records()]
    .filter(
      (record) => !record.parentSessionId && !record.draft && !record.diagnostic && !ports.blocked(record.id),
    )
    .map((record) => {
      const index = ports.index(record.id);
      const snapshot = index.snapshot();
      const boundary = `${snapshot.generation}:${snapshot.endSeq}`;
      const directory = join(ports.directory, "agent", "session-context", record.id);
      const evidencePath = join(
        directory,
        `memory-${createHash("sha256").update(boundary).digest("hex")}.md`,
      );
      const entries = function* () {
        for (const { entry } of index.readReverse(snapshot)) yield entry;
      };
      return {
        id: record.id,
        cwd: ports.cwd(record),
        title: record.title,
        updatedAt: record.updatedAt,
        createdAt: record.createdAt,
        boundary,
        evidencePath,
        eligible: record.archivedAt == null,
        active: ports.active(record.id),
        read: async (afterBoundary?: string) => {
          if (!ports.exists(record.id) || ports.deleting(record.id)) throw new Error("来源会话已删除");
          let afterSeq = 0;
          if (afterBoundary) {
            const separator = afterBoundary.lastIndexOf(":");
            if (afterBoundary.slice(0, separator) !== snapshot.generation) return "";
            afterSeq = Number(afterBoundary.slice(separator + 1));
            if (!Number.isSafeInteger(afterSeq) || afterSeq < 0) throw new Error("storage: 清空记忆边界无效");
          }
          const afterEntries = function* () {
            for (const { entry, seq } of index.readReverse(snapshot)) {
              if (seq <= afterSeq) break;
              yield entry;
            }
          };
          if (afterSeq >= snapshot.endSeq) return "";
          const transcript = sessionReferenceTranscriptReverse(record.title, record.id, entries());
          await mkdir(directory, { recursive: true, mode: 0o700 });
          try {
            await writeFile(evidencePath, transcript, { flag: "wx", mode: 0o600 });
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          }
          return `Workspace: ${JSON.stringify(ports.cwd(record))}\nSource boundary: ${boundary}\nOriginal evidence snapshot: ${JSON.stringify(evidencePath)}\n\n${memoryEvidence(record.title, record.id, afterEntries())}`;
        },
      };
    });
}
