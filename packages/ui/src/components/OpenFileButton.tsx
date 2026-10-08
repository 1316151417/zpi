import * as Menu from "@radix-ui/react-dropdown-menu";
import { ChevronDown, Copy, ExternalLink } from "lucide-react";
import { useState } from "react";
import type { FileAction, FileActionHandler } from "../types.ts";

export function OpenFileButton({
  path,
  name,
  onOpen,
  onAction,
  onError,
}: {
  path: string;
  name?: string;
  onOpen?: (path: string) => void;
  onAction?: FileActionHandler;
  onError: (error: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const perform = async (action: FileAction) => {
    if (!onAction || busy) return;
    setBusy(true);
    onError("");
    try {
      await onAction(path, action);
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Menu.Root>
      <div className="changed-file-open">
        <button
          type="button"
          className="changed-file-open-default"
          disabled={!onOpen || busy}
          aria-label={name ? `打开 ${name}` : "打开"}
          title="在 ZPI 中打开"
          onClick={() => onOpen?.(path)}
        >
          打开
        </button>
        <Menu.Trigger
          className="changed-file-open-menu"
          disabled={!onAction || busy}
          aria-label={name ? `打开菜单 ${name}` : "选择打开方式"}
          title="选择打开方式"
        >
          <ChevronDown size={14} aria-hidden="true" />
        </Menu.Trigger>
      </div>
      <Menu.Portal>
        <Menu.Content className="selection-menu changed-file-menu" align="end" side="top" sideOffset={2}>
          <Menu.Item className="menu-item" onSelect={() => void perform("reveal")}>
            <img
              src={new URL("./file-actions/finder.png", document.baseURI).href}
              width={16}
              height={16}
              alt=""
            />
            <span>Finder</span>
          </Menu.Item>
          <Menu.Item className="menu-item" onSelect={() => void perform("open")}>
            <ExternalLink size={16} aria-hidden="true" />
            <span>使用默认程序打开</span>
          </Menu.Item>
          <Menu.Separator className="changed-file-menu-separator" />
          <Menu.Item className="menu-item" onSelect={() => void perform("copy-absolute")}>
            <Copy size={16} aria-hidden="true" />
            <span>复制绝对路径</span>
          </Menu.Item>
          <Menu.Item className="menu-item" onSelect={() => void perform("copy-relative")}>
            <Copy size={16} aria-hidden="true" />
            <span>复制相对路径</span>
          </Menu.Item>
        </Menu.Content>
      </Menu.Portal>
    </Menu.Root>
  );
}
