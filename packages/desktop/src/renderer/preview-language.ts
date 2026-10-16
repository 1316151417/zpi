// Adapted from ZCode codeViewer.ts (Apache-2.0).
import { toolCodeLanguage } from "zpi-ui/code-language";

/** Preserve the reference's log highlighting for plain text and unknown extensions. */
export function inferPreviewLanguage(path?: string, contentHint?: string) {
  return toolCodeLanguage(path ?? "", contentHint ?? "");
}
