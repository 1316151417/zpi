import * as ContextMenu from "@radix-ui/react-context-menu";
import { ExternalLink } from "lucide-react";
import type { ReactNode } from "react";
import type { WebOpenOptions } from "../link-target.ts";

export function MarkdownLink({
  url,
  children,
  onOpen,
}: {
  url: string;
  children: ReactNode;
  onOpen: (url: string, options?: WebOpenOptions) => void;
}) {
  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>
        <button
          type="button"
          className="message-web-link"
          title={url}
          onClick={(event) => onOpen(url, { forceExternal: event.metaKey || event.ctrlKey })}
        >
          {children}
        </button>
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content className="message-link-menu">
          <ContextMenu.Item onSelect={() => onOpen(url, { forceInApp: true })}>打开</ContextMenu.Item>
          <ContextMenu.Separator />
          <ContextMenu.Item onSelect={() => onOpen(url, { forceExternal: true })}>
            <ExternalLink size={16} />
            在浏览器中打开
          </ContextMenu.Item>
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}
