import { createPreviewLoader } from "ZPI-ui";
import type { Result } from "../shared/bridge.ts";

const unwrap = <T>(result: Result<T>): T => {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
};
export const previewLoader = createPreviewLoader({
  getChangedPaths: async (id, runId) => {
    const changes = unwrap(await window.ZPI.getChanges(id, runId));
    return changes
      .filter(
        (change) =>
          !change.reason?.startsWith("文件快照不可用") &&
          change.status !== "deleted" &&
          change.status !== "reverted",
      )
      .map((change) => change.path);
  },
  checkFilesExist: (params, id) => window.ZPI.checkPreviewFiles(id, params.paths).then(unwrap),
});
