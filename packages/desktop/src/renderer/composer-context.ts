import type { ComposerContext } from "zpi-ui";
import { readMarkdownImage } from "./markdown-image.ts";
import { unwrap } from "./unwrap.ts";
export const inputContext: ComposerContext = {
  readFileChanges: async (sessionId, runId) =>
    unwrap(await window.zpi.getChanges(sessionId, runId, false, true)).map((change) => ({
      path: change.path,
      additions: change.added,
      deletions: change.removed,
      failed: change.failed,
    })),
  readImage: readMarkdownImage,
  readWebSourceIcon: async (sessionId, runId, sourceUrl) =>
    unwrap(await window.zpi.readWebSourceIcon(sessionId, runId, sourceUrl)).dataUrl,
  downloadImage: (src) => window.zpi.downloadImage(src).then(unwrap),
  searchFiles: (id, q) => window.zpi.searchFiles(id, q).then(unwrap),
  listSessionMentions: (id) => window.zpi.listSessionMentions(id).then(unwrap),
  pickAttachments: (id) => window.zpi.pickAttachments(id).then(unwrap),
  importAttachment: (id, file) => window.zpi.importAttachment(id, file).then(unwrap),
  removeAttachment: (id, image) => window.zpi.removeAttachment(id, image).then(unwrap),
  readAttachment: async (id, image) => {
    const result = unwrap(await window.zpi.readAttachment(id, image));
    return `data:${result.metadata.mimeType};base64,${result.data}`;
  },
};
