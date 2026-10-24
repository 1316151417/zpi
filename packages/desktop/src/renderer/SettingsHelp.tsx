import { CircleHelp } from "lucide-react";
import { ActionHint } from "zpi-ui";

export function SettingsHelp({ label, text }: { label: string; text: string }) {
  return (
    <ActionHint label={text} appearance="control" openOnFocus className="settings-help-tooltip">
      <button type="button" className="settings-help" aria-label={`${label}说明`}>
        <CircleHelp size={14} />
      </button>
    </ActionHint>
  );
}
