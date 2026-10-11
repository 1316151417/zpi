import type { ComposerContext } from "ZPI-ui";
import { readMarkdownImage } from "./markdown-image.ts";
import { unwrap } from "./store.ts";
export const inputContext: ComposerContext = {
  readImage: readMarkdownImage,
  downloadImage: (src) => window.ZPI.downloadImage(src).then(unwrap),
  searchFiles: (id, q) => window.ZPI.searchFiles(id, q).then(unwrap),
  pickAttachments: (id) => window.ZPI.pickAttachments(id).then(unwrap),
  importAttachment: (id, file) => window.ZPI.importAttachment(id, file).then(unwrap),
  removeAttachment: (id, image) => window.ZPI.removeAttachment(id, image).then(unwrap),
  readAttachment: async (id, image) => {
    const result = unwrap(await window.ZPI.readAttachment(id, image));
    return `data:${result.metadata.mimeType};base64,${result.data}`;
  },
};
