import { join } from "node:path";
import { StateStore } from "../../packages/desktop/src/main/state-store.ts";
import {
  openStorageGeneration,
  readActiveGeneration,
} from "../../packages/desktop/src/main/storage-generation.ts";

/** Use the same active generation as the desktop, including before first launch. */
export function testStorageDirectory(root: string): string {
  const active = readActiveGeneration(root);
  if (active) return active.directory;
  const storage = openStorageGeneration(root, (directory) => {
    new StateStore(join(directory, "state.sqlite")).close();
  });
  storage.close();
  return storage.directory;
}

export function readStoredDraft(root: string, id: string | null): { text: string } | undefined {
  if (!id) throw new Error("Missing selected task");
  const state = new StateStore(join(testStorageDirectory(root), "state.sqlite"));
  try {
    return state.getDraft(id);
  } finally {
    state.close();
  }
}
