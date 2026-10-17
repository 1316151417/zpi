import * as Menu from "@radix-ui/react-dropdown-menu";
import { Check, ChevronDown } from "lucide-react";
import type { EditorInfo } from "../shared/editors.ts";
import { usePreferredEditor } from "./editor-preference.ts";
import { logRendererError } from "./error-log.ts";
import { unwrap } from "./store.ts";
import "./editor-buttons.css";

export function WorkspaceEditorButton({ sessionId }: { sessionId: string }) {
  const { editors, editor, select } = usePreferredEditor();
  if (!editor) return null;
  const open = (selected: EditorInfo) => {
    select(selected.id);
    void window.zpi
      .openInEditor(sessionId, ".", selected.id)
      .then(unwrap)
      .catch((error) => logRendererError("open-in-editor", error));
  };
  const label = `在 ${editor.name} 中打开`;
  return (
    <div className="workspace-editor-group" data-platform={window.zpi.platform}>
      <button
        type="button"
        className="workspace-editor-open"
        title={label}
        aria-label={label}
        onClick={() => open(editor)}
      >
        <img src={editor.iconDataUrl} alt={editor.name} />
      </button>
      <Menu.Root>
        <Menu.Trigger className="workspace-editor-select" title="选择打开应用" aria-label="选择打开应用">
          <ChevronDown size={14} />
        </Menu.Trigger>
        <Menu.Portal>
          <Menu.Content
            className="parity-menu workspace-editor-menu"
            data-platform={window.zpi.platform}
            align="end"
            sideOffset={2}
            loop
          >
            <Menu.RadioGroup
              className="parity-menu-group"
              value={editor.id}
              onValueChange={(id) => {
                const selected = editors.find((candidate) => candidate.id === id);
                if (selected) open(selected);
              }}
            >
              {editors.map((candidate) => (
                <Menu.RadioItem key={candidate.id} value={candidate.id} className="parity-menu-radio">
                  <img src={candidate.iconDataUrl} alt="" />
                  {candidate.name}
                  <Menu.ItemIndicator className="parity-menu-indicator">
                    <Check size={16} />
                  </Menu.ItemIndicator>
                </Menu.RadioItem>
              ))}
            </Menu.RadioGroup>
          </Menu.Content>
        </Menu.Portal>
      </Menu.Root>
    </div>
  );
}
