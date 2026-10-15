import { join } from "node:path";
import { StateStore } from "../packages/desktop/src/main/state-store.ts";
import { openStorageGeneration } from "../packages/desktop/src/main/storage-generation.ts";
import { seedHistory as seedStoredHistory } from "../packages/desktop/test/helpers/history-fixture.ts";

/** Seed the same SQLite generation/transcript format consumed by the real desktop. */
export function seedHistory(
  dir: string,
  cwd: string,
  calls: number,
  options: Parameters<typeof seedStoredHistory>[4] = {},
) {
  const storage = openStorageGeneration(dir, (directory) => {
    new StateStore(join(directory, "state.sqlite")).close();
  });
  try {
    const state = new StateStore(join(storage.directory, "state.sqlite"));
    try {
      return seedStoredHistory(state, storage.directory, cwd, calls, options);
    } finally {
      state.close();
    }
  } finally {
    storage.close();
  }
}
