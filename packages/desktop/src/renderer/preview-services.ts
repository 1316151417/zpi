import type { PreviewServices } from "zpi-ui";
import { openBrowser, openFile } from "./pane-store.ts";
import { previewLoader } from "./preview-loader.ts";
import { unwrap } from "./store.ts";
export const previewServices: PreviewServices = {
  load: previewLoader.load,
  openFile,
  openWebsite: (id, url) => openBrowser(url, id),
  openExternal: (id, url, path) =>
    path ? window.zpi.fileAction(id, path, "open").then(unwrap) : window.zpi.openExternal(url).then(unwrap),
  fileAction: (id, path, action) => window.zpi.fileAction(id, path, action).then(unwrap),
};
