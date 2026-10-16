import type { ConversationSelection } from "zpi-ui";
import type { PresentationPageElement } from "./types.ts";

export async function fingerprintPresentationBytes(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
  return `sha256:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

/** Preserve exact OOXML identity and original fingerprints in the existing removable context wire format. */
export async function createPresentationSelection(options: {
  path: string;
  bytes: Uint8Array;
  element: PresentationPageElement;
  comment: string;
  selectedText?: string;
}): Promise<ConversationSelection> {
  const { path, bytes, element, comment } = options;
  const reference = {
    sourcePath: path,
    sourceFingerprint: await fingerprintPresentationBytes(bytes),
    slideIndex: element.slideIndex,
    slidePart: element.slidePart,
    nodeId: element.nodeId,
    nodePath: element.nodePath,
    nodeType: element.nodeType,
    rowIndex: element.rowIndex,
    cellIndex: element.cellIndex,
    bounds: element.bounds,
    text: element.text ?? "",
    textFingerprint: await fingerprintPresentationBytes(new TextEncoder().encode(element.text ?? "")),
    selectedText: options.selectedText ?? element.text ?? "",
    comment: comment.trim(),
  };
  return {
    id: crypto.randomUUID(),
    path,
    sourceTitle: `${path.split(/[\\/]/).at(-1)} · 第 ${element.slideIndex + 1} 页`,
    sourceKey: `${path}:${element.slidePart}:${element.nodeId}:${element.rowIndex ?? ""}:${element.cellIndex ?? ""}`,
    contentType: "tool",
    text: `Presentation element comment (apply this comment only to this element):\n${JSON.stringify(reference, null, 2)}`,
  };
}
