// Adapted from Pi c20cb09772bf4e2590a316cb54514cef76df4293.
// Copyright (c) 2025 Mario Zechner. MIT license: licenses/third-party-notices.txt.
import { readlink, realpath } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

const fileMutationQueues = new Map<string, Promise<void>>();
let registrationQueue = Promise.resolve();
const MAX_SYMLINK_EXPANSIONS = 40;

function isMissingPathError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

async function getMutationQueueKey(filePath: string): Promise<string> {
  const resolvedPath = resolve(filePath);
  let ancestor = resolvedPath;
  const missing: string[] = [];
  let symlinks = 0;
  while (true) {
    try {
      return join(await realpath(ancestor), ...missing);
    } catch (error) {
      // Custom operations may target a remote directory that is a local file.
      // Leave validity to the operation, as for other paths absent locally.
      if (error instanceof Error && "code" in error && error.code === "ENOTDIR") return resolvedPath;
      if (!isMissingPathError(error)) throw error;
      let target: string | undefined;
      try {
        target = await readlink(ancestor);
      } catch (linkError) {
        if (
          !isMissingPathError(linkError) &&
          !(
            typeof linkError === "object" &&
            linkError !== null &&
            "code" in linkError &&
            linkError.code === "EINVAL"
          )
        )
          throw linkError;
      }
      if (target !== undefined) {
        if (++symlinks > MAX_SYMLINK_EXPANSIONS)
          throw Object.assign(new Error(`Too many symbolic links: ${filePath}`), { code: "ELOOP" });
        // realpath cannot resolve dangling links. Follow their relative target
        // without losing the missing suffix collected below a directory link.
        ancestor = resolve(dirname(ancestor), target);
        continue;
      }
      const parent = dirname(ancestor);
      if (parent === ancestor) throw error;
      // A missing file can still have symlinked parents. Canonicalize the
      // existing ancestor so aliases share a lock before and after creation.
      missing.unshift(basename(ancestor));
      ancestor = parent;
    }
  }
}

/**
 * Serialize file mutation operations targeting the same file.
 * Operations for different files still run in parallel.
 */
export async function withFileMutationQueue<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
  const registration = registrationQueue.then(async () => {
    const key = await getMutationQueueKey(filePath);
    const currentQueue = fileMutationQueues.get(key) ?? Promise.resolve();

    let releaseNext!: () => void;
    const nextQueue = new Promise<void>((resolveQueue) => {
      releaseNext = resolveQueue;
    });
    const chainedQueue = currentQueue.then(() => nextQueue);
    fileMutationQueues.set(key, chainedQueue);

    return { key, currentQueue, chainedQueue, releaseNext };
  });
  registrationQueue = registration.then(
    () => undefined,
    () => undefined,
  );

  const { key, currentQueue, chainedQueue, releaseNext } = await registration;
  await currentQueue;
  try {
    return await fn();
  } finally {
    releaseNext();
    if (fileMutationQueues.get(key) === chainedQueue) {
      fileMutationQueues.delete(key);
    }
  }
}
