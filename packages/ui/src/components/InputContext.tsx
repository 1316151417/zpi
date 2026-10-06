import type { ImageAttachment } from "ZPI-coding-agent";
import { X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { ConversationSelection } from "../conversation-selections.ts";
import type { FileLocation } from "../link-target.ts";
import { EditorHistory } from "./editor-history.ts";
export interface ComposerDraft {
  selections?: ConversationSelection[];
  selection?: [number, number];
  warnings?: string[];
  text: string;
  fileReferences: string[];
  attachments: ImageAttachment[];
  pending: number;
  error?: string;
}
export class ComposerDraftStore extends Map<string, ComposerDraft> {
  readonly submitting = new Set<string>();
  readonly histories = new Map<string, EditorHistory>();
  private listeners = new Set<(id: string) => void>();
  private contentRevisions = new Map<string, number>();
  revision(id: string): number {
    return this.contentRevisions.get(id) ?? 0;
  }
  history(id: string): EditorHistory {
    let history = this.histories.get(id);
    if (!history) {
      history = new EditorHistory();
      this.histories.set(id, history);
    }
    return history;
  }
  subscribe(listener: (id: string) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  override set(id: string, draft: ComposerDraft): this {
    if (draft.selection) {
      const clamp = (offset: number) => Math.max(0, Math.min(draft.text.length, offset));
      const start = clamp(draft.selection[0]),
        end = clamp(draft.selection[1]);
      if (start !== draft.selection[0] || end !== draft.selection[1])
        draft = { ...draft, selection: [start, end] };
    }
    const previous = this.get(id);
    if (
      !previous ||
      previous.text !== draft.text ||
      JSON.stringify(previous.fileReferences) !== JSON.stringify(draft.fileReferences) ||
      JSON.stringify(previous.selections) !== JSON.stringify(draft.selections)
    )
      this.contentRevisions.set(id, this.revision(id) + 1);
    super.set(id, draft);
    for (const listener of this.listeners) listener(id);
    return this;
  }
  override delete(id: string): boolean {
    const deleted = super.delete(id);
    this.histories.delete(id);
    this.contentRevisions.delete(id);
    for (const listener of this.listeners) listener(id);
    return deleted;
  }
}
export interface ComposerContext {
  searchFiles(
    sessionId: string,
    query: string,
  ): Promise<{ path: string; name: string; absolutePath: string }[]>;
  importImage(sessionId: string, file: File): Promise<ImageAttachment>;
  pickImages(sessionId: string): Promise<ImageAttachment[]>;
  removeAttachment(sessionId: string, id: string): Promise<void>;
  readAttachment(sessionId: string, id: string): Promise<string>;
  readImage?(sessionId: string, path: string, location?: FileLocation): Promise<string>;
  downloadImage?(src: string): Promise<void>;
}
export function ImagePreview({
  sessionId,
  image,
  read,
  remove,
}: {
  sessionId: string;
  image: ImageAttachment;
  read: ComposerContext["readAttachment"];
  remove?: () => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const [src, setSrc] = useState("");
  const [expanded, setExpanded] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    let requested = false;
    const load = () => {
      if (requested) return;
      requested = true;
      void read(sessionId, image.id)
        .then((value) => {
          if (active) setSrc(value);
        })
        .catch((e) => {
          if (active) setError(String(e));
        });
    };
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          load();
          observer.disconnect();
        }
      },
      { rootMargin: "100px" },
    );
    if (root.current) observer.observe(root.current);
    return () => {
      active = false;
      observer.disconnect();
    };
  }, [sessionId, image.id, read]);
  return (
    <div
      ref={root}
      className="image-chip"
      title={`${image.name} · ${image.width}×${image.height}${image.warning ? ` · ${image.warning}` : ""}`}
    >
      <button type="button" aria-label={`预览 ${image.name}`} onClick={() => setExpanded(true)}>
        {src ? <img src={src} alt={image.name} /> : <span>{error || "加载图片…"}</span>}
      </button>
      {remove && (
        <button type="button" aria-label={`移除 ${image.name}`} className="chip-remove" onClick={remove}>
          <X size={12} />
        </button>
      )}
      {expanded && (
        <dialog
          ref={(element) => {
            if (element && !element.open) element.showModal();
          }}
          className="image-lightbox"
          aria-label="图片预览"
          onClick={(event) => {
            if (event.target === event.currentTarget) setExpanded(false);
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              setExpanded(false);
            }
          }}
          onCancel={(event) => {
            event.preventDefault();
            setExpanded(false);
          }}
        >
          <button
            type="button"
            ref={(element) => element?.focus()}
            aria-label="关闭图片预览"
            onClick={() => setExpanded(false)}
          >
            <X size={20} />
          </button>
          {src && <img src={src} alt={image.name} />}
          <span>
            {image.name}
            {error}
          </span>
        </dialog>
      )}
    </div>
  );
}
