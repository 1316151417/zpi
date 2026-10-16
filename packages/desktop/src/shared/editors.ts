export interface EditorInfo {
  id: string;
  name: string;
  iconDataUrl: string;
}

// ZCode pins file managers before code editors, without changing the stored preference.
export function sortEditors(editors: EditorInfo[]): EditorInfo[] {
  const pinned = ["finder", "qspace", "qspace-pro", "explorer"];
  return [
    ...pinned.flatMap((id) => editors.filter((editor) => editor.id === id)),
    ...editors.filter((editor) => !pinned.includes(editor.id)),
  ];
}

export function selectedEditor(editors: EditorInfo[], preference: string | null): EditorInfo | null {
  return editors.find((editor) => editor.id === preference) ?? sortEditors(editors)[0] ?? null;
}
