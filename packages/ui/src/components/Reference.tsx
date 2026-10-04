import type { CSSProperties } from "react";
import { parseMentions } from "zpi-coding-agent/input";
import { fileIconSource } from "../file-icons.ts";

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
  className = "",
}: {
  kind: DisplayReference["kind"];
  path: string;
  label: string;
  onOpen?: (path: string) => void;
  className?: string;
}) {
  const style = referenceStyle(kind, kind === "command" ? label : path);
  return kind === "file" && onOpen ? (
    <button
      type="button"
      className={`inline-mention file ${className}`}
      style={style}
      title={path}
      onClick={() => onOpen(path)}
    >
      <span className="reference-label">{label}</span>
    </button>
  ) : (
    <span className={`inline-mention ${kind} ${className}`} style={style} title={path || undefined}>
      {label}
    </span>
  );
}
