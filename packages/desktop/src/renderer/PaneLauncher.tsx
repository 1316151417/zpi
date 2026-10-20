import { FileDiff, FolderOpen, Globe, MessageSquareText, SquareTerminal } from "lucide-react";
import {
  openBrowser,
  openChanges,
  openFileManager,
  openSideChat,
  openTerminal,
  paneTask,
} from "./pane-store.ts";

export function PaneLauncher({
  sessionId,
  sideChatAvailable,
  hasReview,
}: {
  sessionId?: string;
  sideChatAvailable: boolean;
  hasReview: boolean;
}) {
  const items = [
    {
      id: "files",
      icon: FolderOpen,
      label: "文件",
      description: "从目录中选择一个文件",
      disabled: !sessionId,
      open: () => sessionId && paneTask(openFileManager(sessionId)),
    },
    {
      id: "browser",
      icon: Globe,
      label: "浏览器",
      description: "浏览网页和预览应用。",
      open: () => paneTask(openBrowser("", sessionId)),
    },
    {
      id: "terminal",
      icon: SquareTerminal,
      label: "终端",
      description: "运行命令和查看输出。",
      disabled: !sessionId,
      open: () => sessionId && paneTask(openTerminal(sessionId)),
    },
    ...(!hasReview
      ? [
          {
            id: "review",
            icon: FileDiff,
            label: "审查",
            description: "查看代码变更与差异。",
            disabled: !sessionId,
            open: () => sessionId && openChanges(sessionId, null),
          },
        ]
      : []),
    ...(sideChatAvailable
      ? [
          {
            id: "selection-side-conversation",
            icon: MessageSquareText,
            label: "辅助对话",
            description: "在侧边面板中继续对话。",
            open: () => sessionId && paneTask(openSideChat(sessionId)),
          },
        ]
      : []),
  ];
  return (
    <div className="pane-empty-launcher">
      <div className="pane-launcher-scroll">
        <div className="pane-launcher-inner">
          <h2>新标签页</h2>
          <div className="pane-launcher-actions">
            {items.map(({ id, icon: Icon, label, description, disabled, open }) => (
              <button
                key={id}
                type="button"
                data-side-pane-open-tab-item={id}
                aria-label={label}
                onClick={open}
                disabled={disabled}
              >
                <span className="pane-launcher-icon">
                  <Icon size={24} aria-hidden="true" />
                </span>
                <span className="pane-launcher-copy">
                  <span className="pane-launcher-label">{label}</span>
                  <span className="pane-launcher-description" title={description}>
                    {description}
                  </span>
                </span>
                <span aria-hidden="true" className="pane-launcher-open">
                  打开
                </span>
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
