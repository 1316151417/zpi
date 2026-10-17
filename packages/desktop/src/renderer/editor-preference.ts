import { useEffect, useState, useSyncExternalStore } from "react";
import { type EditorInfo, selectedEditor, sortEditors } from "../shared/editors.ts";
import { readEditorPreference, saveEditorPreference } from "./editor-preference-storage.ts";
import { logRendererError } from "./error-log.ts";
import { unwrap } from "./unwrap.ts";

const listeners = new Set<() => void>();
let currentPreference: string | null | undefined;
function storage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  const changed = () => {
    currentPreference = undefined;
    listener();
  };
  window.addEventListener("storage", changed);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", changed);
  };
};
const snapshot = () =>
  currentPreference === undefined ? readEditorPreference(storage()) : currentPreference;
export function usePreferredEditor() {
  const [editors, setEditors] = useState<EditorInfo[]>([]);
  const preference = useSyncExternalStore(subscribe, snapshot);
  useEffect(() => {
    let disposed = false;
    void window.zpi
      .getInstalledEditors()
      .then(unwrap)
      .then((result) => {
        if (!disposed) setEditors(sortEditors(result));
      })
      .catch((error) => logRendererError("open-in-editor", error));
    return () => {
      disposed = true;
    };
  }, []);
  return {
    editors,
    editor: selectedEditor(editors, preference),
    select: (id: string) => {
      currentPreference = id;
      saveEditorPreference(id, storage());
      for (const listener of listeners) listener();
    },
  };
}
