const preferenceKey = "zpi-last-editor-id";
export function readEditorPreference(storage: Pick<Storage, "getItem"> | null): string | null {
  try {
    return storage?.getItem(preferenceKey) || null;
  } catch {
    return null;
  }
}
export function saveEditorPreference(editorId: string, storage: Pick<Storage, "setItem"> | null): void {
  try {
    storage?.setItem(preferenceKey, editorId);
  } catch {
    /* Storage may be unavailable. */
  }
}
