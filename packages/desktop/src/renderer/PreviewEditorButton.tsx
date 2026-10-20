import { ExternalLink } from "lucide-react";
import { usePreferredEditor } from "./editor-preference.ts";
import { logRendererError } from "./error-log.ts";
import { unwrap } from "./unwrap.ts";

export function PreviewEditorButton({
  sessionId,
  path,
  className,
}: {
  sessionId: string;
  path: string;
  className?: string;
}) {
  const { editor } = usePreferredEditor({ snapshotPreference: true });
  const label = editor ? `在 ${editor.name} 中打开` : "在编辑器中打开";
  return (
    <button
      type="button"
      className={className}
      disabled={!path || !editor}
      title={label}
      aria-label={label}
      onClick={() => {
        if (!editor) return;
        void window.zpi
          .openInEditor(sessionId, path, editor.id)
          .then(unwrap)
          .catch((error) => logRendererError("open-in-editor", error));
      }}
    >
      <ExternalLink size={16} />
    </button>
  );
}
