import * as Menu from "@radix-ui/react-dropdown-menu";
import { ChevronDown, ExternalLink, Globe } from "lucide-react";
import { type CSSProperties, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { LinkContext } from "../link-target.ts";
import type { AssistantPreviewCard } from "../preview/assistant-preview-cards.ts";
import { getAssistantPreviewCardsValidationSignature } from "../preview/assistant-preview-validation.ts";
import {
  advancePreviewAutoOpen,
  type PreviewServices,
  previewInputKey,
} from "../preview/preview-lifecycle.ts";
import type { RunView, SessionView } from "../types.ts";
import { OpenFileButton } from "./OpenFileButton.tsx";
import { FileIcon } from "./Reference.tsx";

const subtitles: Record<string, string> = {
  "chat.previewCards.website": "网站",
  "chat.previewCards.htmlWebsite": "网站 · HTML",
  "chat.previewCards.markdown": "文档 · MD",
  "chat.previewCards.docx": "文档 · DOCX",
  "chat.previewCards.xlsx": "表格 · XLSX",
  "chat.previewCards.pptx": "演示文稿 · PPTX",
  "chat.previewCards.pdf": "文档 · PDF",
  "chat.previewCards.video": "视频",
  "chat.previewCards.audio": "音频",
};
export function usePreviewAutoOpen(view: SessionView) {
  const gate = useRef({ scope: "", armed: false });
  const consumed = useRef(new Set<string>());
  const [target, setTarget] = useState<string | null>(null);
  const latest = view.runs.at(-1);
  useEffect(() => {
    const result = advancePreviewAutoOpen(gate.current, view.sessionId, latest?.status, latest?.runId);
    gate.current = result.state;
    if (result.target !== undefined) setTarget(result.target);
  }, [view.sessionId, latest?.status, latest?.runId]);
  const consume = useCallback((key: string) => {
    if (consumed.current.has(key)) return false;
    consumed.current.add(key);
    return true;
  }, []);
  return useMemo(() => ({ target, consume }), [target, consume]);
}
export function AssistantTurnPreviews({
  run,
  sessionId,
  workspace,
  services,
  autoOpen,
}: {
  run: RunView;
  sessionId: string;
  workspace: LinkContext;
  services: PreviewServices;
  autoOpen?: ReturnType<typeof usePreviewAutoOpen>;
}) {
  const text = run.orderedBlocks
    .flatMap((block) => (block.type === "text" && block.text.trim() ? [block.text] : []))
    .join("\n\n");
  const input = { sessionId, runId: run.runId, text, cwd: workspace.cwd ?? "", home: workspace.home };
  const key = previewInputKey(input);
  const [result, setResult] = useState<{
    key: string;
    services: PreviewServices;
    cards: AssistantPreviewCard[];
  }>();
  const [error, setError] = useState("");
  const canLoad = run.status !== "running" && Boolean(text.trim() && workspace.cwd);
  useEffect(() => {
    if (!canLoad) return;
    let disposed = false;
    const snapshot = JSON.parse(key) as string[];
    void services
      .load({
        sessionId: snapshot[0],
        runId: snapshot[1],
        cwd: snapshot[2],
        home: snapshot[3] || undefined,
        text: snapshot[4],
      })
      .then(
        (cards) => {
          if (!disposed) setResult({ key, services, cards });
        },
        () => {
          if (!disposed) setResult({ key, services, cards: [] });
        },
      );
    return () => {
      disposed = true;
    };
  }, [canLoad, key, services]);
  const visible = canLoad && result?.key === key && result.services === services ? result.cards : undefined;
  const pptx = useMemo(
    () =>
      visible?.filter(
        (card): card is Extract<AssistantPreviewCard, { type: "file" }> =>
          card.type === "file" && card.kind === "pptx",
      ) ?? [],
    [visible],
  );
  useEffect(() => {
    if (!autoOpen || autoOpen.target !== `${sessionId}:${run.runId}` || !pptx.length) return;
    const consumedKey = JSON.stringify([autoOpen.target, getAssistantPreviewCardsValidationSignature(pptx)]);
    if (!autoOpen.consume(consumedKey)) return;
    void (async () => {
      for (const card of pptx) await services.openFile(sessionId, card.path);
    })().catch((error) => setError(String(error)));
  }, [autoOpen?.target, autoOpen?.consume, pptx, services, sessionId, run.runId]);
  if (!visible?.length) return null;
  return (
    <div className="assistant-preview-cards" data-testid="assistant-preview-cards">
      {visible.map((card, index) => (
        <AssistantPreviewCardRow
          key={card.id}
          card={card}
          index={index}
          sessionId={sessionId}
          services={services}
        />
      ))}
      {error && (
        <p className="run-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
export function AssistantPreviewCardRow({
  card,
  index,
  sessionId,
  services,
}: {
  card: AssistantPreviewCard;
  index: number;
  sessionId: string;
  services: PreviewServices;
}) {
  return (
    <div
      className="assistant-preview-card"
      data-preview-type={card.type}
      style={{ "--preview-delay": `${Math.min(index * 36, 240)}ms` } as CSSProperties}
    >
      <div className="assistant-preview-icon">
        {card.type === "website" ? <Globe size={24} /> : <FileIcon path={card.path} size={24} />}
      </div>
      <div className="assistant-preview-description">
        <div className="assistant-preview-title">{card.title}</div>
        <div className="assistant-preview-subtitle">{subtitles[card.subtitleId]}</div>
      </div>
      <PreviewOpenButton card={card} sessionId={sessionId} services={services} />
    </div>
  );
}
function PreviewOpenButton({
  card,
  sessionId,
  services,
}: {
  card: AssistantPreviewCard;
  sessionId: string;
  services: PreviewServices;
}) {
  const [error, setError] = useState("");
  const path = card.type === "website" ? card.filePath : card.path;
  const perform = (promise: Promise<void>) => {
    setError("");
    void promise.catch((error) => setError(error instanceof Error ? error.message : String(error)));
  };
  return (
    <div className="preview-open-control">
      {path ? (
        <OpenFileButton
          path={path}
          onOpen={(path) =>
            perform(
              card.type === "website"
                ? services.openWebsite(sessionId, card.url)
                : services.openFile(sessionId, path),
            )
          }
          onAction={(path, action) => services.fileAction(sessionId, path, action)}
          onError={setError}
        />
      ) : card.type === "website" ? (
        <Menu.Root>
          <div className="preview-open-split">
            <button
              className="preview-open-primary"
              onClick={() => perform(services.openWebsite(sessionId, card.url))}
            >
              打开
            </button>
            <Menu.Trigger className="preview-open-trigger" aria-label="选择打开方式" title="选择打开方式">
              <ChevronDown size={14} />
            </Menu.Trigger>
          </div>
          <Menu.Portal>
            <Menu.Content className="parity-menu preview-open-menu" align="end" side="top" sideOffset={2}>
              <Menu.Item
                className="parity-menu-item"
                onSelect={() =>
                  perform(
                    services.openExternal(
                      sessionId,
                      card.url,
                      card.url.startsWith("file:") ? card.filePath : undefined,
                    ),
                  )
                }
              >
                <ExternalLink size={16} />
                <span>在浏览器中打开</span>
              </Menu.Item>
            </Menu.Content>
          </Menu.Portal>
        </Menu.Root>
      ) : null}
      {error && (
        <span className="preview-open-error" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}
