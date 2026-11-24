import * as ContextMenu from "@radix-ui/react-context-menu";
import { Copy, ExternalLink } from "lucide-react";
import { type ReactNode, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { selectionIntersects } from "../conversation-selections.ts";
import type { WebOpenOptions } from "../link-target.ts";
import { useMarkdown } from "./MarkdownActions.tsx";
import { Notice } from "./Notice.tsx";

export function MarkdownLink({
  url,
  children,
  onOpen,
}: {
  url: string;
  children: ReactNode;
  onOpen: (url: string, options?: WebOpenOptions) => void;
}) {
  const { onCopy } = useMarkdown();
  const anchor = useRef<HTMLButtonElement>(null);
  const [menuContainer, setMenuContainer] = useState<HTMLDialogElement | null>(null);
  const [copyFailed, setCopyFailed] = useState(false);
  return (
    <>
      <ContextMenu.Root
        onOpenChange={(open) => {
          if (open) setMenuContainer(anchor.current?.closest("dialog") ?? null);
        }}
      >
        <ContextMenu.Trigger asChild>
          <button
            ref={anchor}
            type="button"
            className="message-web-link"
            data-conversation-inline-link="true"
            title={url}
            onClick={(event) => {
              if (!selectionIntersects(event.currentTarget))
                onOpen(url, { forceExternal: event.metaKey || event.ctrlKey });
            }}
          >
            {children}
          </button>
        </ContextMenu.Trigger>
        <ContextMenu.Portal container={menuContainer}>
          <ContextMenu.Content className="message-link-menu">
            <ContextMenu.Item onSelect={() => onOpen(url, { forceInApp: true })}>打开</ContextMenu.Item>
            <ContextMenu.Item onSelect={() => onOpen(url, { forceExternal: true })}>
              <ExternalLink size={16} aria-hidden="true" />
              在浏览器中打开
            </ContextMenu.Item>
            {onCopy && (
              <>
                <ContextMenu.Separator />
                <ContextMenu.Item
                  onSelect={() => {
                    setCopyFailed(false);
                    void onCopy(url).catch(() => setCopyFailed(true));
                  }}
                >
                  <Copy size={16} aria-hidden="true" />
                  复制链接
                </ContextMenu.Item>
              </>
            )}
          </ContextMenu.Content>
        </ContextMenu.Portal>
      </ContextMenu.Root>
      {copyFailed &&
        createPortal(
          <Notice scope="window" message="复制链接失败，请重试" onDismiss={() => setCopyFailed(false)} />,
          anchor.current?.closest("dialog, .shell") ?? document.body,
        )}
    </>
  );
}
