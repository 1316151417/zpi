import * as ContextMenu from "@radix-ui/react-context-menu";
import { Copy, ExternalLink } from "lucide-react";
import { type CSSProperties, useState } from "react";
import { parseMentions } from "zpi-coding-agent/input";
import { selectionIntersects } from "../conversation-selections.ts";
import { fallbackFileIconSource, fileIconSource } from "../file-icons.ts";
import type { FileLocation } from "../link-target.ts";
import type { FileAction, FileActionHandler } from "../types.ts";
import { userErrorMessage } from "../user-error.ts";

export interface DisplayReference {
  kind: "file" | "skill" | "command" | "session" | "subagent";
  label: string;
  path: string;
  start: number;
  end: number;
  markdown: string;
}

// Commands keep their canonical slash text. Presentation never changes the Pi input protocol.
export function displayReferences(
  text: string,
  commandNames: readonly string[] = [],
  subagentNames: readonly string[] = [],
): DisplayReference[] {
  const references: DisplayReference[] = parseMentions(text);
  const names = new Set(commandNames.map((name) => name.toLowerCase()));
  for (const match of text.matchAll(
    /(^|\s)\/([a-z0-9_-][a-z0-9_:-]*(?:\/[a-z0-9_-][a-z0-9_:-]*)*)(?=\s|$)/gi,
  )) {
    const name = match[2].toLowerCase().replaceAll(":", "/");
    if (name === "side" || name === "btw") continue;
    if (match[2] !== "init" && match[2] !== "compact" && !names.has(name)) continue;
    const start = match.index + match[1].length;
    if (references.some((reference) => start >= reference.start && start < reference.end)) continue;
    const markdown = `/${match[2]}`;
    references.push({
      kind: "command",
      label: name === "init" ? "Init" : name === "compact" ? "Compact" : name,
      path: "",
      start,
      end: start + markdown.length,
      markdown,
    });
  }
  const agents = new Map(subagentNames.map((name) => [name.toLowerCase(), name]));
  for (const match of text.matchAll(/(^|\s)@([a-z0-9._-]+)(?=\s|$)/gi)) {
    const label = agents.get(match[2].toLowerCase());
    if (!label) continue;
    const start = match.index + match[1].length;
    if (references.some((reference) => start >= reference.start && start < reference.end)) continue;
    const markdown = `@${match[2]}`;
    references.push({ kind: "subagent", label, path: "", start, end: start + markdown.length, markdown });
  }
  return references.sort((a, b) => a.start - b.start);
}

export function referenceStyle(kind: DisplayReference["kind"], path: string): CSSProperties {
  const source =
    kind === "file"
      ? fileIconSource(path)
      : kind === "subagent"
        ? `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 8V4H8"/><rect width="16" height="12" x="4" y="8" rx="2"/><path d="M2 14h2m16 0h2m-7-1v2m-6-2v2"/></svg>')}`
        : kind === "command" && !["init", "compact"].includes(path.toLowerCase())
          ? `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="m9 15 6-6"/></svg>')}`
          : new URL(
              `./mention-icons/${kind === "skill" || kind === "session" ? kind : path.toLowerCase()}.svg`,
              document.baseURI,
            ).href;
  return {
    [kind === "file" ? "--mention-image" : "--mention-mask"]: `url(${JSON.stringify(source)})`,
    ...(kind === "file" ? {} : { "--mention-icon-color": "currentColor" }),
  } as CSSProperties;
}

export function FileIcon({ path, size = 16 }: { path: string; size?: number }) {
  const source = fileIconSource(path);
  return (
    <img
      key={source}
      className="file-type-icon"
      src={source}
      width={size}
      height={size}
      alt=""
      aria-hidden="true"
      onError={(event) => {
        const fallback = fallbackFileIconSource(event.currentTarget.src);
        if (fallback) event.currentTarget.src = fallback;
      }}
    />
  );
}

export function Reference({
  kind,
  path,
  label,
  onOpen,
  onAction,
  location,
  className = "",
}: {
  kind: DisplayReference["kind"];
  path: string;
  label: string;
  onOpen?: (path: string, location?: FileLocation) => void;
  onAction?: FileActionHandler;
  location?: FileLocation;
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
          if (!selectionIntersects(event.currentTarget)) onOpen(path, location);
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
    void onAction(path, action, location).catch((error) => setError(userErrorMessage(error)));
  };
  return (
    <>
      <ContextMenu.Root>
        <ContextMenu.Trigger asChild>{reference}</ContextMenu.Trigger>
        <ContextMenu.Portal>
          <ContextMenu.Content className="message-link-menu message-file-menu">
            <ContextMenu.Item onSelect={() => onOpen(path, location)}>打开</ContextMenu.Item>
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
            <ContextMenu.Item onSelect={() => perform("open")}>
              <ExternalLink size={16} aria-hidden="true" />
              <span>使用默认程序打开</span>
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
