import * as Menu from "@radix-ui/react-dropdown-menu";
import { Check, ChevronRight, Copy, Eye, FileCode2, MoreHorizontal } from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";
import { FileIcon } from "zpi-ui";
import { PreviewEditorButton } from "./PreviewEditorButton.tsx";
import { previewBreadcrumb } from "./preview-breadcrumb.ts";
import { report } from "./store.ts";
import { unwrap } from "./unwrap.ts";
import { useWorkspace } from "./use-workspace.ts";

export function PreviewHeader({
  sessionId,
  path,
  wrap,
  onWrap,
  onViewSource,
  viewMode,
  onViewMode,
  viewKind,
  divider = false,
}: {
  sessionId: string;
  path: string;
  wrap?: boolean;
  onWrap?: () => void;
  onViewSource?: () => void;
  viewMode?: "preview" | "code";
  onViewMode?: (mode: "preview" | "code") => void;
  viewKind?: "Markdown" | "SVG";
  divider?: boolean;
}) {
  const workspace = useWorkspace(sessionId);
  const { root, parents: parts, file: name } = previewBreadcrumb(path, workspace?.cwd);
  const breadcrumb = useRef<HTMLElement>(null);
  const [mask, setMask] = useState("none");
  useLayoutEffect(() => {
    const element = breadcrumb.current;
    if (!element) return;
    const update = () => {
      const max = element.scrollWidth - element.clientWidth;
      const left = element.scrollLeft > 1;
      const right = element.scrollLeft < max - 1;
      setMask(max <= 1 ? "none" : left && right ? "both" : left ? "left" : "right");
    };
    const frame = requestAnimationFrame(() => {
      element.scrollLeft = element.scrollWidth;
      update();
    });
    element.addEventListener("scroll", update, { passive: true });
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => {
      cancelAnimationFrame(frame);
      element.removeEventListener("scroll", update);
      observer.disconnect();
    };
  }, [path, workspace?.cwd]);
  const copy = (action: "copy-absolute" | "copy-relative") => {
    void window.zpi.fileAction(sessionId, path, action).then(unwrap).catch(report);
  };
  return (
    <div className={`preview-header${divider ? " preview-header-divider" : ""}`}>
      <nav
        ref={breadcrumb}
        className="preview-breadcrumb"
        data-mask={mask}
        aria-label="文件路径"
        title={path}
      >
        {root && (
          <>
            <span>{root}</span>
            <ChevronRight size={14} />
          </>
        )}
        {parts.map((part, index) => (
          <span className="preview-path-segment" key={`${index}:${part}`}>
            <span>{part}</span>
            <ChevronRight size={14} />
          </span>
        ))}
        <span className="preview-path-file">
          <FileIcon path={path} size={14} />
          <strong>{name}</strong>
        </span>
      </nav>
      <div className="preview-header-actions">
        {onViewSource && (
          <button className="preview-source" onClick={onViewSource}>
            <FileCode2 size={14} />
            查看源码
          </button>
        )}
        <Menu.Root>
          <Menu.Trigger className="preview-icon-button" aria-label="文件预览菜单" title="更多操作">
            <MoreHorizontal size={14} />
          </Menu.Trigger>
          <Menu.Portal>
            <Menu.Content className="selection-menu preview-menu" align="end" sideOffset={4} loop>
              {onViewMode && (
                <>
                  <Menu.Label className="preview-menu-label">{viewKind}</Menu.Label>
                  <Menu.RadioGroup
                    value={viewMode}
                    onValueChange={(value) => onViewMode(value as "preview" | "code")}
                  >
                    <Menu.RadioItem className="menu-item" value="preview">
                      <Eye size={16} />
                      预览
                      <Menu.ItemIndicator className="preview-menu-check">
                        <Check size={16} />
                      </Menu.ItemIndicator>
                    </Menu.RadioItem>
                    <Menu.RadioItem className="menu-item" value="code">
                      <FileCode2 size={16} />
                      {viewKind === "SVG" ? "代码" : "源码"}
                      <Menu.ItemIndicator className="preview-menu-check">
                        <Check size={16} />
                      </Menu.ItemIndicator>
                    </Menu.RadioItem>
                  </Menu.RadioGroup>
                  <Menu.Separator className="preview-menu-separator" />
                </>
              )}
              {onWrap && (
                <>
                  <Menu.CheckboxItem className="menu-item" checked={wrap} onCheckedChange={onWrap}>
                    <FileCode2 size={16} />
                    自动换行
                    <Menu.ItemIndicator className="preview-menu-check">
                      <Check size={16} />
                    </Menu.ItemIndicator>
                  </Menu.CheckboxItem>
                  <Menu.Separator className="preview-menu-separator" />
                </>
              )}
              <Menu.Item className="menu-item" onSelect={() => copy("copy-absolute")}>
                <Copy size={16} />
                复制绝对路径
              </Menu.Item>
              <Menu.Item className="menu-item" onSelect={() => copy("copy-relative")}>
                <Copy size={16} />
                复制相对路径
              </Menu.Item>
            </Menu.Content>
          </Menu.Portal>
        </Menu.Root>
        <PreviewEditorButton sessionId={sessionId} path={path} className="preview-icon-button" />
      </div>
    </div>
  );
}
