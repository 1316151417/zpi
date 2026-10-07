import { buildMentionMarkdown, imageLimits, parseMentions } from "ZPI-coding-agent/input";
import {
  ArrowDown,
  ArrowUp,
  Brain,
  ChevronRight,
  FileClock,
  GitBranch,
  Info,
  Loader,
  Paperclip,
  Pencil,
  Plus,
  Square,
  TrendingUpDown,
  X,
} from "lucide-react";
import type { ReactNode } from "react";
import {
  Fragment,
  memo,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  buildSelectionPrompt,
  type ConversationSelection,
  parseSelectionPrompt,
} from "../conversation-selections.ts";
import { type FindRequest, type FindState, normalizeFindQuery } from "../find.ts";
import type { FileLocation, LinkContext, WebOpenOptions } from "../link-target.ts";
import { progressSummary } from "../reducer.ts";
import type {
  FileActionHandler,
  FileRewindConflict,
  InputQueue,
  InputSuggestion,
  RunView,
  SessionView,
  ViewBlock,
} from "../types.ts";
import { ChangedFiles } from "./ChangedFiles.tsx";
import { ConversationQueuePanel, type QueueActions } from "./ConversationQueuePanel.tsx";
import { ConversationSelectionMenu, SelectionReferenceChip } from "./ConversationSelections.tsx";
import { DraftGreeting } from "./DraftGreeting.tsx";
import { FileRewindConflictDialog } from "./FileRewindConflictDialog.tsx";
import {
  type ComposerContext,
  type ComposerDraft,
  ComposerDraftStore,
  ImagePreview,
} from "./InputContext.tsx";
import { Markdown } from "./Markdown.tsx";
import { MentionEditor, type MentionEditorHandle } from "./MentionEditor.tsx";
import { ActionHint, CopyMessage, MessageAction, messageTime } from "./MessageActions.tsx";
import { reasoningDuration, reasoningSummary, runPresentation } from "./process-presentation.ts";
import { appendPromptHistory, readPromptHistory, savePromptHistory } from "./prompt-history.ts";
import { displayReferences, FileIcon, Reference, referenceStyle } from "./Reference.tsx";
import { SuggestionOptions } from "./SuggestionOptions.tsx";
import { ToolBlock } from "./ToolBlock.tsx";
import { ToolGroup } from "./ToolGroup.tsx";
import { processItems } from "./tool-presentation.ts";
import { useTextFind } from "./use-text-find.ts";

export interface MessageEditInput {
  workspaceMode?: "preserve" | "rewind";
  text: string;
  fileReferences: string[];
  attachments: string[];
}
export type EditMessage = (
  runId: string,
  input: MessageEditInput,
) => Promise<undefined | { conflicts: FileRewindConflict[] }>;
function UserMessageEditor({
  run,
  sessionId,
  context,
  onEdit,
  onCancel,
}: {
  run: RunView;
  sessionId: string;
  context?: ComposerContext;
  onEdit: EditMessage;
  onCancel: () => void;
}) {
  const storage = useRef(new ComposerDraftStore());
  const [conflict, setConflict] = useState<{ files: FileRewindConflict[]; input: MessageEditInput }>();
  const [resolving, setResolving] = useState(false);
  const report = (error: unknown) => {
    const draft = storage.current.get(sessionId);
    if (draft) storage.current.set(sessionId, { ...draft, error: String(error) });
  };
  const parsed = parseSelectionPrompt(run.userMessage);
  if (!storage.current.has(sessionId))
    storage.current.set(sessionId, {
      text: parsed.text,
      selections: parsed.selections,
      fileReferences: run.fileReferences ?? [],
      attachments: run.attachments ?? [],
      pending: 0,
    });
  return (
    <section className="user-message-editor" aria-label="编辑消息">
      <ChatComposer
        sessionId={sessionId}
        busy={false}
        draftStorage={storage.current}
        context={context}
        showSendButton
        onStop={() => {}}
        onCancel={onCancel}
        resetFiles={{
          disabled:
            run.status === "running" ||
            !run.orderedBlocks.some((block) => block.type === "tool" && block.fileChange),
          description:
            run.status === "running"
              ? "请等待当前工作停止"
              : run.orderedBlocks.some((block) => block.type === "tool" && block.fileChange)
                ? "恢复本轮文件、重置对话并发送"
                : "本轮没有可安全恢复的文件改动",
        }}
        onSubmit={async (text, input) => {
          try {
            const edit: MessageEditInput = {
              text,
              fileReferences: input.fileReferences,
              attachments: input.attachments,
              ...(input.workspaceMode ? { workspaceMode: input.workspaceMode } : {}),
            };
            const result = await onEdit(run.runId, edit);
            if (result?.conflicts) {
              setConflict({ files: result.conflicts, input: edit });
              return "blocked";
            }
            onCancel();
          } catch (error) {
            report(error);
            throw error;
          }
        }}
      />
      {conflict && (
        <FileRewindConflictDialog
          conflicts={conflict.files}
          pending={resolving}
          onClose={() => setConflict(undefined)}
          onContinue={() => {
            setResolving(true);
            void onEdit(run.runId, { ...conflict.input, workspaceMode: "preserve" })
              .then(onCancel)
              .catch(report)
              .finally(() => setResolving(false));
          }}
        />
      )}
    </section>
  );
}
function ProcessBlock({
  block,
  expanded,
  toggle,
  onLink,
  workspace,
  onCopy,
  onFile,
  onFileAction,
  onImage,
  onDownloadImage,
  onChanges,
  onLoadPatch,
}: {
  onImage?: (path: string, location?: FileLocation) => Promise<string>;
  onDownloadImage?: (src: string) => Promise<void>;
  onChanges?: (path: string, toolCallId: string) => void;
  onLoadPatch?: (toolCallId: string) => Promise<string>;
  block: ViewBlock;
  onFile?: (path: string, location?: FileLocation) => void;
  onFileAction?: FileActionHandler;
  expanded: boolean;
  toggle: () => void;
  workspace?: LinkContext;
  onLink: (url: string, options?: WebOpenOptions) => void;
  onCopy?: (text: string) => Promise<void>;
}) {
  const summary = useRef<HTMLSpanElement>(null);
  const streaming = block.type === "thinking" && Boolean(block.streaming);
  const streamingLabel = streaming && !expanded;
  // 对齐 ZCode ReasoningTrigger：末行预览只属于运行态，完成态显示耗时。
  const thinkingSummary = block.type === "thinking" && streamingLabel ? reasoningSummary(block.text) : "";
  const [summaryOverflowing, setSummaryOverflowing] = useState(false);
  const [reasoningNow, setReasoningNow] = useState(Date.now);
  useLayoutEffect(() => {
    const viewport = summary.current;
    if (!viewport || !thinkingSummary) return;
    const sync = () => {
      setSummaryOverflowing(viewport.scrollWidth > viewport.clientWidth + 1);
      viewport.scrollLeft = viewport.scrollWidth;
    };
    sync();
    const observer = new ResizeObserver(sync);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [thinkingSummary]);
  useEffect(() => {
    // 收起时耗时不可见，和 ZCode 一样只在展开流式思考时每秒更新。
    if (!streaming || !expanded) return;
    setReasoningNow(Date.now());
    const timer = setInterval(() => setReasoningNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [streaming, expanded]);
  if (block.type === "tool")
    return (
      <ToolBlock
        block={block}
        expanded={expanded}
        toggle={toggle}
        workspace={workspace}
        onCopy={onCopy}
        onFile={onFile}
        onChanges={onChanges}
        onLoadPatch={onLoadPatch}
      />
    );
  if (block.type === "thinking") {
    const duration =
      block.startedAt !== undefined && (streaming || block.endedAt !== undefined)
        ? reasoningDuration((block.endedAt ?? reasoningNow) - block.startedAt)
        : reasoningDuration();
    return (
      <div className="process-thinking" data-testid="thinking-block">
        <button className="block-toggle" aria-expanded={expanded} onClick={toggle}>
          <Brain size={16} aria-hidden="true" className="process-icon" />
          <strong className={streamingLabel ? "thinking-label-streaming" : undefined}>
            {streamingLabel ? "正在思考" : "思考"}
          </strong>
          {(thinkingSummary || !streamingLabel) && <span className="process-separator">·</span>}
          {thinkingSummary && (
            <span
              ref={summary}
              className="block-summary thinking-summary"
              data-overflowing={summaryOverflowing}
            >
              {thinkingSummary}
            </span>
          )}
          {!streamingLabel && <span className="reasoning-duration">{duration}</span>}
          <ChevronRight
            size={16}
            aria-hidden="true"
            className={`process-chevron ${expanded ? "rotated" : ""}`}
          />
        </button>
        {expanded && (
          <pre
            className="thinking-body"
            data-conversation-selectable="reasoning"
            data-selection-key={block.id}
          >
            {block.text.trim()
              ? block.text
              : block.streaming
                ? "等待模型返回思考摘要…"
                : "模型未返回可展示的思考摘要。"}
          </pre>
        )}
      </div>
    );
  }
  return (
    <div
      className="process-text answer"
      data-find-key={block.id}
      data-conversation-selectable="assistant"
      data-selection-key={block.id}
    >
      <Markdown
        workspace={workspace}
        onImage={onImage}
        onDownloadImage={onDownloadImage}
        text={block.text}
        streaming={Boolean(block.streaming)}
        onLink={onLink}
        onCopy={onCopy}
        onFile={onFile}
        onFileAction={onFileAction}
      />
    </div>
  );
}
const WorkProgress = memo(function WorkProgress({
  run,
  expanded,
  defaultOpen,
  toggle,
}: {
  run: RunView;
  expanded: boolean;
  defaultOpen: boolean;
  toggle: () => void;
}) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (run.status !== "running") return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [run.runId, run.status]);
  return (
    <div className="progress-heading">
      <button className="progress" aria-expanded={expanded} onClick={toggle} data-testid="progress">
        <span>{progressSummary(run, now)}</span>
        {!defaultOpen && <ChevronRight size={16} aria-hidden="true" className={expanded ? "rotated" : ""} />}
      </button>
    </div>
  );
});
export const RunGroup = memo(function RunGroup({
  run,
  onLink,
  workspace,
  expanded,
  onToggle,
  blocks,
  onBlockToggle,
  context,
  onChanges,
  onLoadToolPatch,
  onFileAction,
  onCopy,
  onFile,
  sessionId,
  onEdit,
  onFork,
}: {
  onEdit?: EditMessage;
  onFork?: (runId: string) => Promise<void>;
  run: RunView;
  sessionId?: string;
  context?: ComposerContext;
  onChanges?: (runId: string, path?: string, toolCallId?: string) => void;
  onLoadToolPatch?: (runId: string, toolCallId: string) => Promise<string>;
  onFileAction?: FileActionHandler;
  onCopy?: (text: string) => Promise<void>;
  onFile?: (path: string, location?: FileLocation) => void;
  workspace?: LinkContext;
  onLink: (url: string, options?: WebOpenOptions) => void;
  expanded: boolean;
  onToggle: (runId: string, value: boolean) => void;
  blocks: Record<string, boolean>;
  onBlockToggle: (blockId: string, value: boolean) => void;
}) {
  const openToolChange = useCallback(
    (path: string, toolCallId: string) => onChanges?.(run.runId, path, toolCallId),
    [onChanges, run.runId],
  );
  const loadToolPatch = useCallback(
    (toolCallId: string) => onLoadToolPatch?.(run.runId, toolCallId) ?? Promise.resolve(""),
    [onLoadToolPatch, run.runId],
  );
  const onImage = useCallback(
    (path: string, location?: FileLocation) =>
      context?.readImage && sessionId
        ? context.readImage(sessionId, path, location)
        : Promise.reject(new Error("图片预览不可用")),
    [context, sessionId],
  );
  const [editing, setEditing] = useState(false);
  const [forking, setForking] = useState(false);
  const [actionError, setActionError] = useState("");
  const cancelEdit = useCallback(() => setEditing(false), []);
  const parsedUser = parseSelectionPrompt(run.userMessage);
  useEffect(() => {
    if (!onEdit) setEditing(false);
  }, [onEdit]);
  const { process, answer, defaultOpen } = runPresentation(run);
  const items = processItems(process, run.status === "running");
  const open = defaultOpen || expanded;
  return (
    <article className="run-group" data-testid="run" data-run-id={run.runId} data-status={run.status}>
      <div className="assistant-turn">
        <div className="user-message-row">
          {editing && onEdit && sessionId ? (
            <UserMessageEditor
              run={run}
              sessionId={sessionId}
              context={context}
              onEdit={onEdit}
              onCancel={cancelEdit}
            />
          ) : (
            <>
              <div className="message-images">
                <SelectionReferenceChip references={parsedUser.selections} />
                {context &&
                  sessionId &&
                  run.attachments?.map((image) => (
                    <ImagePreview
                      key={image.id}
                      sessionId={sessionId}
                      image={image}
                      read={context.readAttachment}
                    />
                  ))}
              </div>
              <div className="user-message">
                <div
                  className="user-message-text"
                  data-find-key={`${run.runId}:user`}
                  data-conversation-selectable="user"
                  data-selection-key={`${sessionId}:${run.runId}:user`}
                >
                  {(() => {
                    const parts: ReactNode[] = [];
                    let previous = 0;
                    const mentions = displayReferences(parsedUser.text);
                    for (const mention of mentions) {
                      parts.push(parsedUser.text.slice(previous, mention.start));
                      parts.push(
                        <Reference
                          key={mention.start}
                          kind={mention.kind}
                          path={mention.path}
                          label={mention.label}
                          onOpen={onFile}
                          onAction={onFileAction}
                        />,
                      );
                      previous = mention.end;
                    }
                    parts.push(parsedUser.text.slice(previous));
                    for (const path of run.fileReferences ?? [])
                      if (!mentions.some((m) => m.path === path))
                        parts.push(
                          <Reference
                            key={path}
                            kind="file"
                            path={path}
                            label={path.split("/").at(-1) ?? path}
                            onOpen={onFile}
                            onAction={onFileAction}
                          />,
                        );
                    return parts;
                  })()}
                </div>
              </div>
              <div className="message-actions user-message-actions">
                <CopyMessage text={run.userMessage} onCopy={onCopy} />
                {onEdit && (
                  <MessageAction label="编辑" onClick={() => setEditing(true)}>
                    <Pencil size={14} />
                  </MessageAction>
                )}
              </div>
            </>
          )}
        </div>
        <WorkProgress
          run={run}
          expanded={open}
          defaultOpen={defaultOpen}
          toggle={() => {
            if (!defaultOpen) onToggle(run.runId, !expanded);
          }}
        />
        {open && items.length > 0 && (
          <div className="process" data-testid="process">
            {items.map((item) =>
              item.kind !== "block" ? (
                <ToolGroup
                  key={item.id}
                  group={item}
                  blocks={blocks}
                  toggle={(id) => onBlockToggle(id, !(blocks[id] ?? false))}
                  workspace={workspace}
                  onCopy={onCopy}
                  onFile={onFile}
                  onChanges={onChanges ? openToolChange : undefined}
                  onLoadPatch={onLoadToolPatch ? loadToolPatch : undefined}
                />
              ) : (
                <ProcessBlock
                  workspace={workspace}
                  key={item.id}
                  onImage={onImage}
                  onDownloadImage={context?.downloadImage}
                  block={item.block}
                  expanded={blocks[item.id] ?? false}
                  toggle={() => onBlockToggle(item.id, !(blocks[item.id] ?? false))}
                  onLink={onLink}
                  onCopy={onCopy}
                  onFile={onFile}
                  onFileAction={onFileAction}
                  onChanges={onChanges ? openToolChange : undefined}
                  onLoadPatch={onLoadToolPatch ? loadToolPatch : undefined}
                />
              ),
            )}
          </div>
        )}
        {run.notice && (
          <div className="run-notice" role="status">
            {run.notice}
          </div>
        )}
        {run.status === "running" && (
          <div
            className="chat-loading-slot"
            role="status"
            aria-label={run.apiRetry?.attempt && run.apiRetry.attempt >= 3 ? undefined : "加载中"}
          >
            {run.apiRetry && run.apiRetry.attempt >= 3 ? (
              <span
                className="api-retry-status"
                title={`重新连接中... ${run.apiRetry.attempt}/${run.apiRetry.maxRetries}${run.apiRetry.errorStatus == null ? "" : ` · HTTP ${run.apiRetry.errorStatus}`}`}
                data-testid="api-retry-status"
              >
                <span className="thinking-label-streaming api-retry-label">
                  重新连接中... {run.apiRetry.attempt}/{run.apiRetry.maxRetries}
                </span>
              </span>
            ) : (
              <div className="chat-loading-icon">
                <Loader className="chat-loading-spinner" size={16} aria-hidden="true" />
              </div>
            )}
          </div>
        )}
        {run.error && (
          <div role="alert" className="run-error">
            {run.error}
          </div>
        )}
        {run.status === "aborted" && <div className="run-notice">运行已停止，保留已收到的内容。</div>}
        {run.status === "interrupted" && (
          <div className="run-notice">应用退出时运行尚未结束，工具未重新执行。</div>
        )}
        <div className="assistant-message-row">
          {answer && (
            <div
              className="answer"
              data-find-key={`${run.runId}:answer`}
              data-conversation-selectable="assistant"
              data-selection-key={`${sessionId}:${run.runId}:answer`}
            >
              <Markdown
                workspace={workspace}
                onImage={onImage}
                onDownloadImage={context?.downloadImage}
                text={answer.text}
                streaming={Boolean(answer.streaming)}
                onLink={onLink}
                onCopy={onCopy}
                onFile={onFile}
                onFileAction={onFileAction}
              />
            </div>
          )}
          <ChangedFiles
            run={run}
            cwd={workspace?.cwd}
            onChanges={onChanges}
            onFile={onFile}
            onFileAction={onFileAction}
          />
          {answer && (
            <div className="message-actions assistant-message-actions">
              <CopyMessage
                text={run.orderedBlocks
                  .flatMap((block) => (block.type === "text" ? [block.text] : []))
                  .join("\n\n")}
                onCopy={onCopy}
              />
              {onFork && (
                <MessageAction
                  label="分叉"
                  disabled={forking}
                  onClick={() => {
                    setForking(true);
                    setActionError("");
                    void onFork(run.runId)
                      .catch((error) => setActionError(String(error)))
                      .finally(() => setForking(false));
                  }}
                >
                  <TrendingUpDown size={14} />
                </MessageAction>
              )}
              <span className="message-time">{messageTime(answer.startedAt ?? run.startedAt)}</span>
            </div>
          )}
          {actionError && (
            <div className="run-error" role="alert">
              {actionError}
            </div>
          )}
        </div>
      </div>
    </article>
  );
});
export function Conversation({
  view,
  onLink,
  workspace,
  context,
  onChanges,
  onLoadToolPatch,
  onFileAction,
  onCopy,
  onFile,
  hasEarlier = false,
  loadingEarlier = false,
  onLoadEarlier,
  historyCursor,
  onEdit,
  onFork,
  onAddSelection,
  onNavigateOrigin,
  findRequest,
  onFindStateChange,
  findBar,
}: {
  findRequest?: FindRequest;
  onFindStateChange?: (state: FindState) => void;
  findBar?: ReactNode;
  onNavigateOrigin?: (origin: NonNullable<SessionView["forkOrigin"]>) => void;
  onEdit?: EditMessage;
  onFork?: (runId: string) => Promise<void>;
  onAddSelection?: (reference: ConversationSelection) => void;
  hasEarlier?: boolean;
  loadingEarlier?: boolean;
  onLoadEarlier?: () => Promise<void>;
  historyCursor?: number | null;
  view: SessionView;
  workspace?: LinkContext;
  onLink: (url: string, options?: WebOpenOptions) => void;
  context?: ComposerContext;
  onChanges?: (runId: string, path?: string, toolCallId?: string) => void;
  onLoadToolPatch?: (runId: string, toolCallId: string) => Promise<string>;
  onFileAction?: FileActionHandler;
  onCopy?: (text: string) => Promise<void>;
  onFile?: (path: string, location?: FileLocation) => void;
}) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [blocks, setBlocks] = useState<Record<string, boolean>>({});
  const lifecycle = useRef(new Map<string, boolean>());
  const manualBlocks = useRef(new Set<string>());
  useEffect(() => {
    setExpanded((current) => {
      const next = { ...current };
      for (const run of view.runs) {
        const key = `run:${view.sessionId}:${run.runId}`;
        const wasRunning = lifecycle.current.get(key);
        if (wasRunning && run.status !== "running") next[run.runId] = false;
        lifecycle.current.set(key, run.status === "running");
      }
      return Object.keys(next).length === Object.keys(current).length &&
        Object.keys(next).every((key) => next[key] === current[key])
        ? current
        : next;
    });
    setBlocks((current) => {
      const next = { ...current };
      for (const run of view.runs)
        for (const block of run.orderedBlocks) {
          if (block.type !== "thinking") continue;
          const key = `block:${view.sessionId}:${run.runId}:${block.id}`;
          const wasStreaming = lifecycle.current.get(key);
          if (wasStreaming && !block.streaming && !manualBlocks.current.has(`${view.sessionId}:${block.id}`))
            next[block.id] = false;
          else if (next[block.id] === undefined) next[block.id] = false;
          lifecycle.current.set(key, Boolean(block.streaming));
        }
      return Object.keys(next).length === Object.keys(current).length &&
        Object.keys(next).every((key) => next[key] === current[key])
        ? current
        : next;
    });
  }, [view]);
  const toggleBlock = useCallback(
    (blockId: string, value: boolean) => {
      manualBlocks.current.add(`${view.sessionId}:${blockId}`);
      setBlocks((current) => ({ ...current, [blockId]: value }));
    },
    [view.sessionId],
  );
  const toggle = useCallback(
    (runId: string, value: boolean) => setExpanded((current) => ({ ...current, [runId]: value })),
    [],
  );
  const ref = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const lastScrollTop = useRef(0);
  const latestRun = useRef<string | undefined>(undefined);
  const navigateFind = useCallback((_match: unknown, range?: Range) => {
    const root = ref.current;
    if (!root || !range) return;
    following.current = false;
    const bounds = range.getBoundingClientRect();
    const viewport = root.getBoundingClientRect();
    root.scrollTo({
      top: root.scrollTop + bounds.top - viewport.top - root.clientHeight / 2 + bounds.height / 2,
      // ZCode first brings the target turn into view, then refines the visible hit smoothly.
      behavior: bounds.bottom < viewport.top || bounds.top > viewport.bottom ? "instant" : "smooth",
    });
  }, []);
  useTextFind({
    rootRef: ref,
    request: findRequest,
    content: view,
    scopeKey: view.sessionId,
    onStateChange: onFindStateChange,
    onNavigate: navigateFind,
  });
  const findQuery = normalizeFindQuery(findRequest?.query ?? "");
  const findLoadAttempt = useRef("");
  useEffect(() => {
    if (
      !findQuery ||
      !hasEarlier ||
      loadingEarlier ||
      !onLoadEarlier ||
      view.runs.reduce((count, run) => count + 1 + run.orderedBlocks.length, 0) >= 1200
    )
      return;
    const attempt = `${view.sessionId}:${findQuery}:${historyCursor}`;
    if (attempt === findLoadAttempt.current) return;
    findLoadAttempt.current = attempt;
    void onLoadEarlier();
  }, [findQuery, hasEarlier, loadingEarlier, onLoadEarlier, historyCursor, view]);
  const scrollToBottom = () => {
    const el = ref.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    lastScrollTop.current = el.scrollTop;
  };
  const [showLatest, setShowLatest] = useState(false);
  useEffect(() => {
    const navigate = (event: Event) => {
      const detail = (event as CustomEvent<{ sessionId: string; runId: string }>).detail;
      const root = ref.current;
      if (!root || detail.sessionId !== view.sessionId) return;
      const target = root.querySelector<HTMLElement>(`[data-run-id="${CSS.escape(detail.runId)}"]`);
      if (!target) return;
      following.current = false;
      root.scrollTop += target.getBoundingClientRect().top - root.getBoundingClientRect().top;
      setShowLatest(root.scrollHeight - root.scrollTop - root.clientHeight >= 60);
    };
    window.addEventListener("ZPI:scroll-to-run", navigate);
    return () => window.removeEventListener("ZPI:scroll-to-run", navigate);
  }, [view.sessionId]);

  const prepend = useRef<{ height: number; top: number } | null>(null);
  const readingWrite = useRef<{ key: string; value: string } | null>(null);
  const readingTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const flushReading = useCallback(() => {
    clearTimeout(readingTimer.current);
    readingTimer.current = undefined;
    const pending = readingWrite.current;
    readingWrite.current = null;
    if (pending) {
      try {
        localStorage.setItem(pending.key, pending.value);
      } catch {
        // A bookmark is optional when browser storage is unavailable.
      }
    }
  }, []);
  useEffect(() => {
    window.addEventListener("pagehide", flushReading);
    return () => window.removeEventListener("pagehide", flushReading);
  }, [flushReading]);
  const saveReading = () => {
    const el = ref.current;
    if (!el) return;
    readingWrite.current = {
      key: `ZPI.reading.${view.sessionId}`,
      value: JSON.stringify({ top: el.scrollTop, following: following.current, cursor: historyCursor ?? 0 }),
    };
    readingTimer.current ??= setTimeout(flushReading, 250);
  };
  useLayoutEffect(() => {
    let saved: { top: number; following: boolean } | undefined;
    try {
      saved = JSON.parse(localStorage.getItem(`ZPI.reading.${view.sessionId}`) ?? "null") ?? undefined;
    } catch {
      /* Invalid optional bookmark starts at latest. */
    }
    following.current = saved?.following ?? true;
    latestRun.current = view.runs.at(-1)?.runId;
    if (ref.current) ref.current.scrollTop = following.current ? ref.current.scrollHeight : (saved?.top ?? 0);
    const el = ref.current;
    lastScrollTop.current = el?.scrollTop ?? 0;
    setShowLatest(Boolean(el && el.scrollHeight - el.clientHeight - el.scrollTop >= 60));
    return flushReading;
  }, [view.sessionId, flushReading]);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const tail = view.runs.at(-1)?.runId;
    if (tail !== latestRun.current) {
      latestRun.current = tail;
      if (!findQuery) following.current = true;
    }
    if (prepend.current) {
      el.scrollTop = prepend.current.top + el.scrollHeight - prepend.current.height;
      lastScrollTop.current = el.scrollTop;
      prepend.current = null;
    } else if (following.current) scrollToBottom();
    setShowLatest(el.scrollHeight - el.scrollTop - el.clientHeight >= 60);
    saveReading();
  }, [view]);
  useEffect(() => {
    if (!ref.current) return;
    const observer = new ResizeObserver(() => {
      const el = ref.current;
      if (!el) return;
      if (following.current) scrollToBottom();
      setShowLatest(el.scrollHeight - el.scrollTop - el.clientHeight >= 60);
    });
    const child = ref.current.firstElementChild;
    if (child) observer.observe(child);
    return () => observer.disconnect();
  }, [view.sessionId]);
  return (
    <div className="conversation-wrap">
      {findBar}
      <div
        ref={ref}
        className="conversation"
        onScroll={() => {
          const el = ref.current;
          if (el) {
            // Layout growth and delayed diagram rendering must not disable following.
            // Only movement towards older content changes the reading mode.
            if (
              el.scrollTop < lastScrollTop.current - 1 &&
              el.scrollHeight - el.scrollTop - el.clientHeight >= 60
            )
              following.current = false;
            lastScrollTop.current = el.scrollTop;
            setShowLatest(el.scrollHeight - el.scrollTop - el.clientHeight >= 60);
            saveReading();
          }
        }}
      >
        <div className="conversation-inner">
          {hasEarlier && (
            <button
              className="load-history"
              disabled={loadingEarlier}
              onClick={() => {
                const el = ref.current;
                if (!el || !onLoadEarlier) return;
                following.current = false;
                prepend.current = { height: el.scrollHeight, top: el.scrollTop };
                void onLoadEarlier().finally(() => {
                  if (prepend.current) prepend.current = null;
                });
              }}
            >
              {loadingEarlier ? "正在加载…" : "加载更早的十次调用"}
            </button>
          )}
          {view.runs.length ? (
            view.runs.map((run) => (
              <Fragment key={run.runId}>
                <RunGroup
                  workspace={workspace}
                  key={run.runId}
                  run={run}
                  sessionId={view.sessionId}
                  context={context}
                  onEdit={run.runId === view.runs.at(-1)?.runId ? onEdit : undefined}
                  onFork={onFork}
                  onChanges={onChanges}
                  onLoadToolPatch={onLoadToolPatch}
                  onFileAction={onFileAction}
                  onCopy={onCopy}
                  onFile={onFile}
                  onLink={onLink}
                  expanded={Boolean(
                    expanded[run.runId] ||
                      (findQuery &&
                        runPresentation(run).process.some(
                          (block) =>
                            block.type === "text" && normalizeFindQuery(block.text).includes(findQuery),
                        )),
                  )}
                  onToggle={toggle}
                  blocks={blocks}
                  onBlockToggle={toggleBlock}
                />
                {view.forkOrigin?.runId === run.runId && (
                  <button
                    type="button"
                    className="fork-notice"
                    onClick={() => view.forkOrigin && onNavigateOrigin?.(view.forkOrigin)}
                  >
                    <span />
                    <strong>
                      <GitBranch size={14} />
                      <span>从对话中派生</span>
                    </strong>
                    <span />
                  </button>
                )}
              </Fragment>
            ))
          ) : (
            <div className="empty-chat">
              <DraftGreeting />
            </div>
          )}
        </div>
      </div>
      <ConversationSelectionMenu rootRef={ref} scopeKey={view.sessionId} onAdd={onAddSelection} />
      {showLatest && (
        <button
          className="latest"
          type="button"
          aria-label="回到最新"
          onClick={() => {
            following.current = true;
            scrollToBottom();
            setShowLatest(false);
            saveReading();
          }}
        >
          <ArrowDown size={16} aria-hidden="true" />
        </button>
      )}
    </div>
  );
}
export function ChatComposer({
  busy,
  onSubmit,
  onStop,
  sessionId,
  toolbar,
  header,
  historyScope,
  sentMessages = [],
  suggestions = [],
  showSendButton = true,
  draftStorage,
  context,
  queue,
  queueActions,
  onFile,
  onCancel,
  resetFiles,
}: {
  onCancel?: () => void;
  resetFiles?: { disabled: boolean; description: string };
  onFile?: (path: string, location?: FileLocation) => void;
  busy: boolean;
  onSubmit: (
    text: string,
    input: {
      fileReferences: string[];
      attachments: string[];
      queueDisposition?: "keep" | "clear";
      workspaceMode?: "preserve" | "rewind";
    },
  ) => Promise<void> | Promise<"confirmationRequired" | "blocked" | undefined>;
  onStop: () => void;
  sessionId: string;
  toolbar?: ReactNode;
  header?: ReactNode;
  historyScope?: string;
  sentMessages?: readonly string[];
  suggestions?: InputSuggestion[];
  showSendButton?: boolean;
  draftStorage?: ComposerDraftStore;
  context?: ComposerContext;
  queue?: InputQueue;
  queueActions?: Omit<QueueActions, "edit"> & { edit(itemId: string): Promise<ComposerDraft> };
}) {
  const emptyDraft = (): ComposerDraft => ({ text: "", fileReferences: [], attachments: [], pending: 0 });
  const drafts = useRef(draftStorage ?? new ComposerDraftStore());
  const [value, setValue] = useState<ComposerDraft>(() => {
    const initial = drafts.current.get(sessionId) ?? emptyDraft();
    drafts.current.set(sessionId, initial);
    return initial;
  });
  const draft = value.text;
  const workspace = historyScope ?? sessionId;
  const promptHistory = useRef<string[]>([]);
  const currentWorkspace = useRef(workspace);
  const recalled = useRef<{ index: number; text: string } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [editing, setEditing] = useState(false);
  const [queueConfirmation, setQueueConfirmation] = useState(false);
  const submitLock = useRef(false);
  const composing = useRef(false);
  const textarea = useRef<MentionEditorHandle>(null);
  const root = useRef<HTMLDivElement>(null);
  const addButton = useRef<HTMLButtonElement>(null);
  const filePanel = useRef<HTMLDivElement>(null);
  const filePanelId = useId();
  useEffect(() => {
    if (onCancel) {
      const frame = requestAnimationFrame(() => textarea.current?.focus());
      return () => cancelAnimationFrame(frame);
    }
  }, [onCancel]);
  const [inputQuery, setInputQuery] = useState<{
    start: number;
    end: number;
    trigger: "/" | "$";
    query: string;
  }>();
  const updateValue = (id: string, change: (old: ComposerDraft) => ComposerDraft) => {
    const old = drafts.current.get(id);
    if (!old) return;
    const next = change(old);
    if (next === old) return;
    drafts.current.set(id, next);
  };
  const updateDraft = (text: string) => updateValue(currentSession.current, (old) => ({ ...old, text }));
  const [fileQuery, setFileQuery] = useState<{
    start: number;
    end: number;
    query: string;
    explicit?: boolean;
  }>();
  const [fileMatches, setFileMatches] = useState<Awaited<ReturnType<ComposerContext["searchFiles"]>>>([]);
  const [fileError, setFileError] = useState("");
  const [fileLoading, setFileLoading] = useState(false);
  const fileOptions = useMemo(
    () => (fileQuery?.explicit ? [null, ...fileMatches] : fileMatches),
    [fileQuery?.explicit, fileMatches],
  );
  useLayoutEffect(() => {
    if (!fileQuery?.explicit) return;
    const panel = filePanel.current;
    const composer = root.current;
    if (!panel || !composer) return;
    const clippingContainers: HTMLElement[] = [];
    for (let container = composer.parentElement; container; container = container.parentElement)
      if (["hidden", "clip", "auto", "scroll"].includes(getComputedStyle(container).overflowY))
        clippingContainers.push(container);
    const fit = () => {
      const top = Math.max(
        8,
        ...clippingContainers.map((container) => container.getBoundingClientRect().top + container.clientTop),
      );
      const footerHeight = panel.querySelector(".composer-add-hint")?.getBoundingClientRect().height ?? 0;
      panel.style.setProperty(
        "--composer-add-list-height",
        `${Math.max(0, composer.getBoundingClientRect().top - top - footerHeight - 6)}px`,
      );
    };
    fit();
    panel.focus();
    const observer = new ResizeObserver(fit);
    observer.observe(composer);
    for (const container of clippingContainers) observer.observe(container);
    window.addEventListener("resize", fit);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", fit);
    };
  }, [fileQuery?.explicit]);
  useEffect(() => {
    let active = true;
    setFileMatches([]);
    setFileError("");
    setFileLoading(Boolean(fileQuery && context));
    if (fileQuery && context)
      void context
        .searchFiles(sessionId, fileQuery.query)
        .then((files) => {
          if (active) {
            setFileMatches(files);
            setFileLoading(false);
          }
        })
        .catch((e) => {
          if (active) {
            setFileError(String(e));
            setFileLoading(false);
          }
        });
    return () => {
      active = false;
    };
  }, [sessionId, fileQuery?.query, fileQuery?.explicit, context]);
  const chooseFile = (file: (typeof fileMatches)[number]) => {
    const range = fileQuery;
    if (!range) return;
    const markdown = buildMentionMarkdown(
      file.name,
      file.absolutePath + (file.type === "directory" ? "/" : ""),
    );
    const start = range.start,
      end = range.end;
    updateValue(sessionId, (old) => ({
      ...old,
      text: `${old.text.slice(0, start) + markdown} ${old.text.slice(end)}`,
      fileReferences: [],
    }));
    setFileQuery(undefined);
    setInputQuery(undefined);
    textarea.current?.focus();
    textarea.current?.setSelectionRange(start + markdown.length + 1, start + markdown.length + 1);
  };
  const addImages = async (operation: () => Promise<import("ZPI-coding-agent").ImageAttachment[]>) => {
    const id = sessionId;
    updateValue(id, (old) => ({ ...old, pending: old.pending + 1, error: undefined }));
    try {
      const images = await operation();
      const old = drafts.current.get(id);
      if (!old) {
        await Promise.all(images.map((image) => context?.removeAttachment(id, image.id).catch(() => {})));
        return;
      }
      if (old.attachments.length + images.length > imageLimits.count) {
        await Promise.all(images.map((image) => context?.removeAttachment(id, image.id)));
        throw new Error("每条消息最多 8 张图片");
      }
      updateValue(id, (old) => ({ ...old, attachments: [...old.attachments, ...images] }));
    } catch (e) {
      updateValue(id, (old) => ({ ...old, error: String(e) }));
    } finally {
      updateValue(id, (old) => ({ ...old, pending: Math.max(0, old.pending - 1) }));
    }
  };
  const chooseAttachment = () => {
    setFileQuery(undefined);
    setInputQuery(undefined);
    const id = sessionId;
    if (context)
      void addImages(() => context.pickImages(id)).finally(() => {
        if (currentSession.current === id) textarea.current?.focus();
      });
  };
  const chooseFileOption = () => {
    const option = fileOptions[highlighted] ?? fileOptions[0];
    if (option) chooseFile(option);
    else if (option === null) chooseAttachment();
  };
  const currentSession = useRef(sessionId);
  const [highlighted, setHighlighted] = useState(0);
  const matches = useMemo(
    () =>
      inputQuery
        ? suggestions.filter(
            (suggestion) =>
              (inputQuery.trigger === "$"
                ? suggestion.group === "Skill"
                : suggestion.group === "命令" && ["init", "compact"].includes(suggestion.name)) &&
              suggestion.name.toLowerCase().includes(inputQuery.query.toLowerCase()),
          )
        : [],
    [inputQuery, suggestions],
  );
  const menuOpen = Boolean(inputQuery);
  const insert = (suggestion: InputSuggestion) => {
    if (!inputQuery) return;
    const { start, end } = inputQuery;
    const inserted = suggestion.insert;
    updateDraft(draft.slice(0, start) + inserted + draft.slice(end));
    setInputQuery(undefined);
    // The editor applies this caret when it renders the new text, before another user selection.
    textarea.current?.focus();
    textarea.current?.setSelectionRange(start + inserted.length, start + inserted.length);
  };
  useLayoutEffect(() => {
    currentSession.current = sessionId;
    if (!drafts.current.has(sessionId)) drafts.current.set(sessionId, emptyDraft());
    setValue(drafts.current.get(sessionId) ?? emptyDraft());
    setFileQuery(undefined);
    setInputQuery(undefined);
    setQueueConfirmation(false);
    currentWorkspace.current = workspace;
    promptHistory.current = readPromptHistory(workspace, sentMessages);
    recalled.current = null;
  }, [sessionId, workspace]);
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      if (
        document.querySelector(
          'dialog[open], [role="dialog"], [role="menu"], [role="listbox"], .settings-screen',
        )
      )
        return;
      const positions = drafts.current.get(sessionId)?.selection;
      textarea.current?.focus();
      if (positions) textarea.current?.setSelectionRange(...positions);
    });
    return () => cancelAnimationFrame(frame);
  }, [sessionId]);
  useEffect(
    () =>
      drafts.current.subscribe((id) => {
        if (id === currentSession.current) setValue(drafts.current.get(id) ?? emptyDraft());
      }),
    [],
  );
  useEffect(() => {
    const close = (e: PointerEvent) => {
      if (!(e.target instanceof Node)) return;
      if (!root.current?.contains(e.target)) {
        setInputQuery(undefined);
        setFileQuery(undefined);
      } else if (
        fileQuery?.explicit &&
        !filePanel.current?.contains(e.target) &&
        !addButton.current?.contains(e.target)
      ) {
        setFileQuery(undefined);
      }
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [fileQuery?.explicit]);
  const hasDraft = Boolean(
    draft.trim() ||
      value.attachments.length ||
      value.fileReferences.length ||
      value.selections?.length ||
      value.pending,
  );
  const submit = async (queueDisposition?: "keep" | "clear", workspaceMode?: "preserve" | "rewind") => {
    if (
      editing ||
      submitLock.current ||
      drafts.current.submitting.has(sessionId) ||
      submitting ||
      value.pending ||
      (!draft.trim() &&
        !value.attachments.length &&
        !value.fileReferences.length &&
        !value.selections?.length)
    )
      return;
    const submitted = value,
      submittedSession = sessionId,
      submittedRevision = drafts.current.revision(sessionId),
      submittedHistory = promptHistory.current;
    submitLock.current = true;
    drafts.current.submitting.add(submittedSession);
    setSubmitting(true);
    try {
      const result = await onSubmit(buildSelectionPrompt(submitted.text, submitted.selections ?? []), {
        ...(workspaceMode ? { workspaceMode } : {}),
        ...(queueDisposition ? { queueDisposition } : {}),
        fileReferences: [
          ...new Set([
            ...submitted.fileReferences,
            ...parseMentions(submitted.text)
              .filter((m) => m.kind === "file")
              .map((m) => m.path),
          ]),
        ],
        attachments: submitted.attachments.map((e) => e.id),
      });
      if (result === "confirmationRequired") {
        if (currentSession.current === submittedSession) setQueueConfirmation(true);
        return;
      }
      if (result === "blocked") return;
      setQueueConfirmation(false);
      const entries = appendPromptHistory(readPromptHistory(workspace, submittedHistory), submitted.text);
      savePromptHistory(workspace, entries);
      if (currentWorkspace.current === workspace) {
        promptHistory.current = entries;
        recalled.current = null;
      }
      const current = drafts.current.get(submittedSession);
      if (current) {
        const unchanged =
          drafts.current.revision(submittedSession) === submittedRevision &&
          current.text === submitted.text &&
          JSON.stringify(current.fileReferences) === JSON.stringify(submitted.fileReferences) &&
          JSON.stringify(current.selections) === JSON.stringify(submitted.selections);
        const usedImages = new Set(submitted.attachments.map((image) => image.id));
        const next = {
          ...current,
          error: undefined,
          ...(unchanged
            ? { text: "", fileReferences: [], selections: [], selection: [0, 0] as [number, number] }
            : {}),
          attachments: current.attachments.filter((image) => !usedImages.has(image.id)),
        };
        drafts.current.set(submittedSession, next);
        if (unchanged) {
          drafts.current.history(submittedSession).clear();
          if (currentSession.current === submittedSession) {
            setFileQuery(undefined);
            setInputQuery(undefined);
          }
        }
      }
    } catch {
      /* Caller displays the business error; preserve the complete draft. */
    } finally {
      submitLock.current = false;
      drafts.current.submitting.delete(submittedSession);
      setSubmitting(false);
    }
  };
  const editQueued = async (itemId: string) => {
    if (!queueActions || editing || submitLock.current) return;
    const id = sessionId,
      current = drafts.current.get(id);
    if (
      current &&
      (current.text.trim() ||
        current.fileReferences.length ||
        current.selections?.length ||
        current.attachments.length ||
        current.pending)
    )
      throw new Error("请先发送或清空当前草稿，再编辑队列消息。");
    setEditing(true);
    submitLock.current = true;
    drafts.current.submitting.add(id);
    try {
      const restored = await queueActions.edit(itemId);
      const parsed = parseSelectionPrompt(restored.text);
      drafts.current.set(id, { ...restored, text: parsed.text, selections: parsed.selections });
      if (currentSession.current === id) {
        requestAnimationFrame(() => {
          if (currentSession.current !== id) return;
          textarea.current?.focus();
          textarea.current?.setSelectionRange(restored.text.length, restored.text.length);
        });
      }
    } finally {
      drafts.current.submitting.delete(id);
      submitLock.current = false;
      setEditing(false);
    }
  };
  return (
    <form
      onSubmit={(event) => event.preventDefault()}
      className={`composer-stack${header ? " with-header" : ""}`}
      onKeyDown={(event) => {
        if (
          onCancel &&
          !submitting &&
          event.key === "Escape" &&
          !event.defaultPrevented &&
          !event.nativeEvent.isComposing
        ) {
          event.preventDefault();
          onCancel();
        }
      }}
    >
      {header}
      {queue && queueActions && (
        <ConversationQueuePanel
          key={sessionId}
          queue={queue}
          actions={{ ...queueActions, edit: editQueued }}
          onError={(error) => updateValue(sessionId, (old) => ({ ...old, error: String(error) }))}
        />
      )}
      <div className="composer" ref={root}>
        <div className="input-context">
          <SelectionReferenceChip
            references={value.selections ?? []}
            onChange={(selections) => updateValue(sessionId, (old) => ({ ...old, selections }))}
          />

          {context &&
            value.attachments.map((image) => (
              <ImagePreview
                key={image.id}
                sessionId={sessionId}
                image={image}
                read={context.readAttachment}
                remove={() => {
                  void context
                    .removeAttachment(sessionId, image.id)
                    .then(() =>
                      updateValue(sessionId, (old) => ({
                        ...old,
                        attachments: old.attachments.filter((e) => e.id !== image.id),
                      })),
                    )
                    .catch((e) => updateValue(sessionId, (old) => ({ ...old, error: String(e) })));
                }}
              />
            ))}
        </div>
        {value.pending > 0 && <small role="status">正在处理图片…</small>}
        {value.error && (
          <div className="run-error" role="alert">
            {value.error}
            <button
              type="button"
              aria-label="关闭附件错误"
              onClick={() => updateValue(sessionId, (old) => ({ ...old, error: undefined }))}
            >
              ×
            </button>
          </div>
        )}
        {fileQuery && (
          <div
            id={filePanelId}
            className={`command-panel${fileQuery.explicit ? " composer-add-panel" : ""}`}
            role="listbox"
            aria-label={fileQuery.explicit ? "添加上下文" : "引用文件"}
            tabIndex={-1}
            ref={filePanel}
            onKeyDown={(e) => {
              if (!fileQuery.explicit || e.nativeEvent.isComposing || e.keyCode === 229) return;
              if (!["Escape", "ArrowDown", "ArrowUp", "Enter", "Tab", " "].includes(e.key)) return;
              e.preventDefault();
              e.stopPropagation();
              if (e.key === "Escape") {
                setFileQuery(undefined);
                addButton.current?.focus();
              } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                setHighlighted(
                  (n) => (n + (e.key === "ArrowDown" ? 1 : -1) + fileOptions.length) % fileOptions.length,
                );
              } else chooseFileOption();
            }}
          >
            <SuggestionOptions selectedIndex={highlighted} options={fileOptions}>
              {fileQuery.explicit && (
                <>
                  <div className="composer-add-heading">添加</div>
                  <button
                    type="button"
                    role="option"
                    aria-selected={highlighted === 0}
                    className="composer-attachment-option"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={chooseAttachment}
                  >
                    <Paperclip size={16} aria-hidden="true" />
                    <strong>附件</strong>
                  </button>
                  <div className="composer-add-heading">文件</div>
                </>
              )}
              {fileError && <p role="alert">{fileError}</p>}
              {fileLoading && <p role="status">正在搜索…</p>}
              {fileMatches.map((file, i) => (
                <button
                  type="button"
                  role="option"
                  aria-selected={i + (fileQuery.explicit ? 1 : 0) === highlighted}
                  className="file-option"
                  key={file.path}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => chooseFile(file)}
                >
                  <FileIcon path={file.path + (file.type === "directory" ? "/" : "")} />
                  <strong>{file.name}</strong>
                  {file.path.includes("/") && (
                    <span>{file.path.slice(0, file.path.lastIndexOf("/") + 1)}</span>
                  )}
                </button>
              ))}
              {!fileMatches.length && !fileError && !fileLoading && <p>暂无匹配文件</p>}
            </SuggestionOptions>
            {fileQuery.explicit ? (
              <div className="composer-add-hint">
                {[
                  ["@", "添加上下文"],
                  ["/", "选择能力"],
                  ["$", "选择技能"],
                ].map(([key, label]) => (
                  <span key={key}>
                    <code>{key}</code>
                    {label}
                  </span>
                ))}
                <span>
                  <Info size={16} aria-hidden="true" />
                  输入内容以搜索文件
                </span>
              </div>
            ) : !fileQuery.query ? (
              <div className="command-hint">
                <Info size={16} aria-hidden="true" />
                在输入框中输入 @ 搜索文件
              </div>
            ) : null}
          </div>
        )}
        {menuOpen && !fileQuery && (
          <div className="command-panel">
            <SuggestionOptions
              selectedIndex={highlighted}
              options={matches}
              label={inputQuery?.trigger === "$" ? "技能" : "指令"}
            >
              {!matches.length && <p>暂无匹配{inputQuery?.trigger === "$" ? "技能" : "指令"}</p>}
              {matches.map((suggestion, index) => (
                <button
                  type="button"
                  role="option"
                  aria-selected={index === highlighted}
                  key={suggestion.insert}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => insert(suggestion)}
                >
                  <span
                    className={`reference-menu-icon ${inputQuery?.trigger === "$" ? "skill" : "command"}`}
                    style={referenceStyle(inputQuery?.trigger === "$" ? "skill" : "command", suggestion.name)}
                    aria-hidden="true"
                  />
                  <strong>
                    {inputQuery?.trigger}
                    {suggestion.name}
                  </strong>
                  <span>{suggestion.description}</span>
                </button>
              ))}
            </SuggestionOptions>
            {!inputQuery?.query && (
              <div className="command-hint">
                <Info size={16} aria-hidden="true" />
                输入内容以搜索{inputQuery?.trigger === "$" ? "技能" : "指令"}
              </div>
            )}
          </div>
        )}
        {value.warnings?.map((warning) => (
          <small key={warning} role="status" className="draft-warning">
            {warning}
          </small>
        ))}
        <MentionEditor
          key={sessionId}
          ref={textarea}
          onFile={onFile}
          history={drafts.current.history(sessionId)}
          initialSelection={value.selection}
          onSelection={(selection) =>
            updateValue(sessionId, (old) => {
              if (old.selection?.[0] === selection[0] && old.selection?.[1] === selection[1]) return old;
              return { ...old, selection };
            })
          }
          value={draft}
          disabled={editing}
          placeholder={busy ? "继续输入以排队后续修改" : undefined}
          onPaste={(e) => {
            if (!context) return;
            const images = Array.from(e.clipboardData.items)
              .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
              .map((item) => item.getAsFile())
              .filter((f): f is File => Boolean(f));
            if (!images.length) return;
            e.preventDefault();
            const text = e.clipboardData.getData("text/plain");
            const start = textarea.current?.selectionStart ?? draft.length,
              end = textarea.current?.selectionEnd ?? start;
            if (text) {
              updateDraft(draft.slice(0, start) + text + draft.slice(end));
              textarea.current?.setSelectionRange(start + text.length, start + text.length);
            }
            void addImages(async () => {
              const imported: import("ZPI-coding-agent").ImageAttachment[] = [];
              try {
                for (const file of images) {
                  if (file.size > imageLimits.sourceBytes) throw new Error("图片单张上限为 10 MiB");
                  imported.push(await context.importImage(sessionId, file));
                }
                return imported;
              } catch (error) {
                await Promise.all(imported.map((image) => context.removeAttachment(sessionId, image.id)));
                throw error;
              }
            });
          }}
          onChange={(text, caret) => {
            if (text !== recalled.current?.text) recalled.current = null;
            updateValue(sessionId, (old) => ({
              ...old,
              text,
              error: undefined,
              warnings: old.warnings?.filter(
                (warning) =>
                  parseMentions(text).some((mention) => warning.endsWith(mention.path)) ||
                  old.fileReferences.some((path) => warning.endsWith(path)),
              ),
              selection: [caret, caret],
            }));
            const prefix = text.slice(0, caret);
            const mention = /(?:^|\s)@([^\s@]*)$/.exec(prefix);
            setFileQuery(
              mention && context
                ? { start: caret - mention[1].length - 1, end: caret, query: mention[1] }
                : undefined,
            );
            const command = /(?:^|\s)([/$])([^\s/$]*)$/.exec(prefix);
            setInputQuery(
              command
                ? {
                    start: caret - command[2].length - 1,
                    end: caret,
                    trigger: command[1] as "/" | "$",
                    query: command[2],
                  }
                : undefined,
            );
            setHighlighted(0);
          }}
          onCompositionStart={() => {
            composing.current = true;
          }}
          onCompositionEnd={() => {
            composing.current = false;
          }}
          onKeyDown={(e) => {
            const isComposing = composing.current || e.nativeEvent.isComposing || e.keyCode === 229;
            if (!isComposing && (fileQuery || inputQuery)) {
              const options = fileQuery ? fileOptions : matches;
              if (e.key === "Escape") {
                e.preventDefault();
                setFileQuery(undefined);
                setInputQuery(undefined);
                return;
              }
              if (options.length && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
                e.preventDefault();
                setHighlighted(
                  (n) => (n + (e.key === "ArrowDown" ? 1 : -1) + options.length) % options.length,
                );
                return;
              }
              if (options.length && ((e.key === "Enter" && !e.shiftKey) || e.key === "Tab")) {
                e.preventDefault();
                if (fileQuery) chooseFileOption();
                else {
                  const suggestion = matches[highlighted] ?? matches[0];
                  if (suggestion) insert(suggestion);
                }
                return;
              }
            }
            if (
              (e.key === "ArrowUp" || e.key === "ArrowDown") &&
              !e.shiftKey &&
              !e.ctrlKey &&
              !e.altKey &&
              !e.metaKey &&
              !isComposing &&
              (draft.length === 0 || recalled.current?.text === draft) &&
              !value.attachments.length &&
              !value.fileReferences.length &&
              !value.pending &&
              promptHistory.current.length
            ) {
              e.preventDefault();
              const entries = promptHistory.current;
              const at = recalled.current?.index;
              const index =
                at === undefined ? entries.length - 1 : e.key === "ArrowUp" ? Math.max(0, at - 1) : at + 1;
              const text = entries[index] ?? "";
              recalled.current = text ? { index, text } : null;
              updateValue(sessionId, (old) => ({
                ...old,
                text,
                error: undefined,
                warnings: undefined,
                selection: [text.length, text.length],
              }));
              setFileQuery(undefined);
              setInputQuery(undefined);
              textarea.current?.setSelectionRange(text.length, text.length);
              return;
            }
            if (e.key === "Enter" && !e.shiftKey && !isComposing) {
              e.preventDefault();
              void submit();
            }
          }}
        />
        <div className="composer-footer">
          <button
            ref={addButton}
            type="button"
            className="composer-plus"
            aria-label="添加上下文"
            aria-haspopup="listbox"
            aria-expanded={Boolean(fileQuery?.explicit)}
            aria-controls={fileQuery?.explicit ? filePanelId : undefined}
            disabled={editing || !context}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              if (fileQuery?.explicit) {
                setFileQuery(undefined);
                textarea.current?.focus();
              } else {
                setFileQuery({
                  start: textarea.current?.selectionStart ?? draft.length,
                  end: textarea.current?.selectionEnd ?? draft.length,
                  query: "",
                  explicit: true,
                });
                setInputQuery(undefined);
                setHighlighted(0);
              }
            }}
          >
            <Plus size={16} aria-hidden="true" />
          </button>
          <div className="composer-actions">
            {toolbar}
            {onCancel && (
              <MessageAction label="取消" shortcut="Esc" disabled={submitting} onClick={onCancel}>
                <X size={16} />
              </MessageAction>
            )}
            {resetFiles && (
              <ActionHint label="与文件一起重置" description={resetFiles.description} side="top">
                <span className="edit-rewind-tooltip">
                  <button
                    type="button"
                    className="edit-rewind"
                    aria-label="对话 + 文件重置"
                    disabled={submitting || resetFiles.disabled || !hasDraft || value.pending > 0}
                    onClick={() => void submit(undefined, "rewind")}
                  >
                    <FileClock size={16} />
                  </button>
                </span>
              </ActionHint>
            )}
            {busy && !hasDraft ? (
              <ActionHint label="停止生成" shortcut="Esc" side="top" className="composer-stop-tooltip">
                <button type="button" className="send stop" aria-label="停止" onClick={onStop}>
                  <Square size={16} fill="currentColor" />
                </button>
              </ActionHint>
            ) : showSendButton || busy ? (
              <button
                className="send"
                aria-label={busy ? "加入队列" : "发送"}
                title={busy ? "加入队列" : "发送"}
                disabled={
                  submitting ||
                  editing ||
                  value.pending > 0 ||
                  (!draft.trim() &&
                    !value.attachments.length &&
                    !value.fileReferences.length &&
                    !value.selections?.length)
                }
                onClick={() => void submit()}
              >
                <ArrowUp size={16} />
              </button>
            ) : null}
          </div>
        </div>
      </div>
      {queueConfirmation && (
        <dialog
          className="queue-confirmation"
          ref={(element) => {
            if (element && !element.open) element.showModal();
          }}
          onCancel={() => setQueueConfirmation(false)}
        >
          <h3>发送消息？</h3>
          <p>你即将发送一条消息。要清除之前已排队的 {queue?.items.length ?? 0} 条消息吗？</p>
          <div>
            <button onClick={() => setQueueConfirmation(false)}>取消</button>
            <button disabled={submitting} onClick={() => void submit("clear")}>
              清空队列
            </button>
            <button disabled={submitting} className="primary" onClick={() => void submit("keep")}>
              发送消息
            </button>
          </div>
        </dialog>
      )}
    </form>
  );
}
