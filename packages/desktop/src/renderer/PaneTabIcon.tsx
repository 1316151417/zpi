import {
  Activity,
  Bot,
  File,
  FileDiff,
  FolderOpen,
  Globe,
  MessageSquareText,
  SquareTerminal,
} from "lucide-react";
import { FileIcon } from "zpi-ui";
import type { PaneTab } from "./pane-store.ts";
export function PaneTabIcon({ tab }: { tab: PaneTab }) {
  if (tab.type === "new-tab") return <File size={14} />;
  if (tab.type === "file-manager") return <FolderOpen size={14} />;
  if (tab.type === "subagent") return <Bot size={14} />;
  if (tab.type === "task-directory") return <Activity size={14} />;
  if (tab.type === "side-chat" || tab.type === "side-chat-loading") return <MessageSquareText size={14} />;
  if (tab.type === "changes")
    return tab.path ? <FileIcon path={tab.path} size={14} /> : <FileDiff size={14} />;
  if (tab.type === "terminal" || tab.type === "background-task") return <SquareTerminal size={14} />;
  if (tab.type === "file") return <FileIcon path={tab.preview.path} size={14} />;
  return <Globe size={14} />;
}
