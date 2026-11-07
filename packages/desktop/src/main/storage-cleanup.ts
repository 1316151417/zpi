import { lstat, open, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { StateStore } from "./state-store.ts";
import { taskFromRow } from "./task-state.ts";
import { canonicalTranscriptPath } from "./transcript-schema.ts";
import { validateTranscriptHeader } from "./transcript-v2.ts";

/** Only managed regular files qualify. A symlink at any level is a diagnostic, not deletion authority. */
async function managedPath(root: string, file: string): Promise<boolean> {
  const name = relative(root, file);
  if (!name || name.startsWith("..") || isAbsolute(name))
    throw new Error("storage: cleanup path outside managed directory");
  let current = root;
  for (const part of ["", ...name.split(/[\\/]/)]) {
    current = join(current, part);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink()) throw new Error("storage: cleanup refuses symbolic links");
      if (current === file && !info.isFile())
        throw new Error("storage: cleanup transcript is not a regular file");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }
  return true;
}
async function assertOwner(file: string, taskId: string, declaredDeletedFile: boolean): Promise<void> {
  const handle = await open(file, "r");
  try {
    const bytes = Buffer.alloc(64 * 1024);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    const end = bytes.subarray(0, bytesRead).indexOf(10);
    let header: ReturnType<typeof validateTranscriptHeader>;
    try {
      if (end < 0) throw new Error("incomplete header");
      header = validateTranscriptHeader(JSON.parse(bytes.subarray(0, end).toString("utf8")));
    } catch {
      // Explicit deletion also applies to the tombstone's own damaged file. Other generations
      // require header evidence; they are never guessed from a damaged header.
      if (declaredDeletedFile) return;
      throw new Error("storage: cleanup cannot verify transcript header");
    }
    if (header.id !== taskId) throw new Error("storage: cleanup transcript identity mismatch");
  } finally {
    await handle.close();
  }
}

/** Called after logical deletion, and on startup after intent recovery, before exposing the host.
 * Retired generations are queued only with a committed locator change. Unproven orphans stay untouched.
 */
export async function retryStorageCleanup(
  state: StateStore,
  directory: string,
  deleteResources: (id: string) => Promise<void>,
  report: (error: unknown, id: string) => void,
  onlyTask?: string,
  deleteIndex?: (file: string) => Promise<void>,
): Promise<void> {
  const dataRoot = dirname(canonicalTranscriptPath(join(directory, "state.sqlite")));
  const sessions = join(dataRoot, "agent", "sessions");
  const absolute = (path: string) => canonicalTranscriptPath(resolve(dataRoot, path));
  const key = (path: string) => relative(dataRoot, absolute(path));
  const finish = (kind: string, id: string, path: string) =>
    state.db.prepare("DELETE FROM storage_cleanup WHERE kind=? AND task_id=? AND path=?").run(kind, id, path);
  const attempt = async (
    job: ReturnType<StateStore["pendingCleanup"]>[number],
    work: () => Promise<void>,
  ) => {
    try {
      await work();
    } catch (error) {
      // Keep bounded diagnostics in the durable queue; ErrorLog applies the usual secret redaction.
      const message = error instanceof Error ? error.message : "storage: cleanup failed";
      try {
        state.db
          .prepare(
            "UPDATE storage_cleanup SET attempts=attempts+1,last_error=? WHERE kind=? AND task_id=? AND path=?",
          )
          .run(message.slice(0, 1024), job.kind, job.taskId, job.path);
      } catch (diagnosticError) {
        report(diagnosticError, job.taskId); // The durable job remains retryable even if diagnostics cannot be written.
      }
      report(error, job.taskId);
    }
  };
  for (const job of state
    .pendingCleanup()
    .filter((job) => job.kind === "task" && (!onlyTask || job.taskId === onlyTask))) {
    await attempt(job, async () => {
      const row = state.db
        .prepare("SELECT * FROM tasks WHERE id=? AND deleted_at IS NOT NULL")
        .get(job.taskId);
      if (!row) throw new Error("storage: cleanup requires a deleted task");
      const task = taskFromRow(row);
      if (task.sessionFile) state.enqueueCleanup("transcript", task.id, key(task.sessionFile));
      await deleteResources(task.id);
      finish(job.kind, job.taskId, job.path);
    });
  }
  for (const job of state
    .pendingCleanup()
    .filter((job) => job.kind === "transcript" && (!onlyTask || job.taskId === onlyTask))) {
    await attempt(job, async () => {
      const file = absolute(job.path);
      // Re-read references per attempt. Archived tasks count as live, and all unresolved intents protect files.
      if (
        state.listTasks().some((task) => task.sessionFile && absolute(task.sessionFile) === file) ||
        state
          .listIntents()
          .some(
            (intent) =>
              intent.taskId === job.taskId ||
              absolute(intent.targetFile) === file ||
              (intent.resultFile && absolute(intent.resultFile) === file),
          )
      )
        throw new Error("storage: cleanup deferred: transcript still referenced by task or recovery intent");
      if (await managedPath(sessions, file)) {
        const deleted = state.db
          .prepare("SELECT * FROM tasks WHERE id=? AND deleted_at IS NOT NULL")
          .get(job.taskId);
        const declaredFile = deleted ? taskFromRow(deleted).sessionFile : undefined;
        const name = basename(file);
        const declaredDeletedFile = Boolean(
          declaredFile &&
            absolute(declaredFile) === file &&
            (name === `${job.taskId}.jsonl` ||
              (name.startsWith(`${job.taskId}.generation-`) &&
                /^[0-9a-f-]{36}\.jsonl$/.test(name.slice(`${job.taskId}.generation-`.length)))),
        );
        await assertOwner(file, job.taskId, declaredDeletedFile);
        await rm(file); // ENOENT on retry is accepted by managedPath; no recursive transcript deletion.
      }
      await deleteIndex?.(file);
      state.transaction("cleanup.transcript", job.taskId, () => {
        finish(job.kind, job.taskId, job.path);
      });
    });
  }
}
