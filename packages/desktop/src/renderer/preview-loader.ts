import { createPreviewLoader } from "zpi-ui";
import { unwrap } from "./unwrap.ts";
export const previewLoader = createPreviewLoader({
  getChangedPaths: async (id, runId) => {
    const changes = unwrap(await window.zpi.getChanges(id, runId, false));
    return changes
      .filter(
        (change) =>
          !change.reason?.startsWith("文件快照不可用") &&
          change.status !== "deleted" &&
          change.status !== "reverted",
      )
      .map((change) => change.path);
  },
  checkFilesExist: (params, id) => window.zpi.checkPreviewFiles(id, params.paths).then(unwrap),
});
