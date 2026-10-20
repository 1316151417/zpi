import { ExternalLink } from "lucide-react";
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
  const label = "使用默认程序打开";
  return (
    <button
      type="button"
      className={className}
      disabled={!path}
      title={label}
      aria-label={label}
      onClick={() => {
        void window.zpi
          .fileAction(sessionId, path, "open")
          .then(unwrap)
          .catch((error) => logRendererError("open-default-file", error));
      }}
    >
      <ExternalLink size={14} />
    </button>
  );
}
