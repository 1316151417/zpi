import type { PreviewServices } from "ZPI-ui";
import { openBrowser, openFile } from "./pane-store.ts";
import { previewLoader } from "./preview-loader.ts";
import { unwrap } from "./store.ts";
export const previewServices: PreviewServices = {
  load: previewLoader.load,
  openFile,
  openWebsite: (id, url) => openBrowser(url, id),
  openExternal: (id, url, path) =>
    path ? window.ZPI.fileAction(id, path, "open").then(unwrap) : window.ZPI.openExternal(url).then(unwrap),
  fileAction: (id, path, action) => window.ZPI.fileAction(id, path, action).then(unwrap),
  listOpenApps: () => window.ZPI.listFileOpenApps().then(unwrap),
  openWith: (id, path, appId) => window.ZPI.openFileWith(id, path, appId).then(unwrap),
};
