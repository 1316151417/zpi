import * as ContextMenu from "@radix-ui/react-context-menu";
import { Copy } from "lucide-react";
import { type CSSProperties, useState } from "react";
import { parseMentions } from "zpi-coding-agent/input";
import { selectionIntersects } from "../conversation-selections.ts";
import { fileIconSource } from "../file-icons.ts";
import type { FileAction, FileActionHandler } from "../types.ts";

export interface DisplayReference {
  kind: "file" | "skill" | "command";
  label: string;
  path: string;
  start: number;
  end: number;
  markdown: string;
}

// Commands keep their canonical slash text. Presentation never changes the Pi input protocol.
export function displayReferences(text: string): DisplayReference[] {
  const references: DisplayReference[] = parseMentions(text);
  for (const match of text.matchAll(/(^|\s)\/(init|compact)(?=\s|$)/g)) {
    const start = match.index + match[1].length;
    if (references.some((reference) => start >= reference.start && start < reference.end)) continue;
    const markdown = `/${match[2]}`;
    references.push({
      kind: "command",
      label: match[2] === "init" ? "Init" : "Compact",
      path: "",
      start,
      end: start + markdown.length,
      markdown,
    });
  }
  return references.sort((a, b) => a.start - b.start);
}

export function referenceStyle(kind: DisplayReference["kind"], path: string): CSSProperties {
  const source =
    kind === "file"
      ? fileIconSource(path)
      : new URL(`./mention-icons/${kind === "skill" ? "skill" : path.toLowerCase()}.svg`, document.baseURI)
          .href;
  return {
    [kind === "file" ? "--mention-image" : "--mention-mask"]: `url(${JSON.stringify(source)})`,
    ...(kind === "file" ? {} : { "--mention-icon-color": "currentColor" }),
  } as CSSProperties;
}

export function FileIcon({ path, size = 16 }: { path: string; size?: number }) {
  return <img className="file-type-icon" src={fileIconSource(path)} width={size} height={size} alt="" />;
}

export function Reference({
  kind,
  path,
  label,
  onOpen,
  onAction,
  className = "",
}: {
  kind: DisplayReference["kind"];
  path: string;
  label: string;
  onOpen?: (path: string) => void;
  onAction?: FileActionHandler;
  className?: string;
}) {
  const [error, setError] = useState("");
  const style = referenceStyle(kind, kind === "command" ? label : path);
  const reference =
    kind === "file" && onOpen ? (
      <button
        type="button"
        className={`inline-mention file ${className}`}
        data-conversation-inline-link="true"
        style={style}
        title={path}
        onClick={(event) => {
          if (!selectionIntersects(event.currentTarget)) onOpen(path);
        }}
      >
        <span className="reference-label">{label}</span>
      </button>
    ) : (
      <span className={`inline-mention ${kind} ${className}`} style={style} title={path || undefined}>
        {label}
      </span>
    );
  if (kind !== "file" || !onOpen || !onAction) return reference;
  const perform = (action: FileAction) => {
    setError("");
    void onAction(path, action).catch((error) =>
      setError(error instanceof Error ? error.message : String(error)),
    );
  };
  return (
    <>
      <ContextMenu.Root>
        <ContextMenu.Trigger asChild>{reference}</ContextMenu.Trigger>
        <ContextMenu.Portal>
          <ContextMenu.Content className="message-link-menu message-file-menu">
            <ContextMenu.Item onSelect={() => onOpen(path)}>打开</ContextMenu.Item>
            <ContextMenu.Separator />
            <ContextMenu.Item onSelect={() => perform("reveal")}>
              <img
                src={new URL("./file-actions/finder.png", document.baseURI).href}
                width={16}
                height={16}
                alt=""
              />
              <span>Finder</span>
            </ContextMenu.Item>
            <ContextMenu.Separator />
            <ContextMenu.Item onSelect={() => perform("copy-absolute")}>
              <Copy size={16} aria-hidden="true" />
              <span>复制绝对路径</span>
            </ContextMenu.Item>
            <ContextMenu.Item onSelect={() => perform("copy-relative")}>
              <Copy size={16} aria-hidden="true" />
              <span>复制相对路径</span>
            </ContextMenu.Item>
          </ContextMenu.Content>
        </ContextMenu.Portal>
      </ContextMenu.Root>
      {error && (
        <span role="alert" className="run-error">
          {error}
        </span>
      )}
    </>
  );
}
