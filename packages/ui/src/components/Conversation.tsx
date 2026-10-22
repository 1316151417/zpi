import {
  ArrowDown,
  ArrowUp,
  Brain,
  ChevronRight,
  FileClock,
  GitBranch,
  Hand,
  Info,
  Loader,
  MessagesSquare,
  Paperclip,
  Pencil,
  Plus,
  Square,
  TrendingUpDown,
  WandSparkles,
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
import { buildMentionMarkdown, imageLimits, parseMentions } from "zpi-coding-agent/input";
import {
  buildSelectionPrompt,
  type ConversationSelection,
  parseSelectionPrompt,
} from "../conversation-selections.ts";
import { type FindMatch, type FindRequest, type FindState, normalizeFindQuery } from "../find.ts";
import {
  type FileLocation,
  type FileOpenHandler,
  type LinkContext,
  splitFileLocation,
  type WebOpenOptions,
} from "../link-target.ts";
import type { PreviewServices } from "../preview/preview-lifecycle.ts";
import { progressSummary } from "../reducer.ts";
import type {
  CompactionView,
  FileActionHandler,
  FileRewindConflict,
  InputQueue,
  InputSuggestion,
  RunView,
  SessionMentionSuggestion,
  SessionView,
  SubagentTask,
  ViewBlock,
} from "../types.ts";
import { attachmentLimitMessage, userErrorMessage } from "../user-error.ts";
import { AnswerSources } from "./AnswerSources.tsx";
import { AssistantTurnPreviews, usePreviewAutoOpen } from "./AssistantPreviewCards.tsx";
import { collectAnswerSources } from "./answer-sources.ts";
import { ChangedFiles } from "./ChangedFiles.tsx";
import { CompactionDivider } from "./CompactionDivider.tsx";
import { ConversationQueuePanel, type QueueActions } from "./ConversationQueuePanel.tsx";
import { ConversationSelectionMenu, SelectionReferenceChip } from "./ConversationSelections.tsx";
import {
  customCommandNames,
  slashSuggestionLabel,
  slashSuggestions,
  slashTokenEnd,
  subagentNames,
} from "./command-suggestions.ts";
import { DraftGreeting } from "./DraftGreeting.tsx";
import { FileRewindConflictDialog } from "./FileRewindConflictDialog.tsx";
import { fileMentionQuery } from "./file-mention-query.ts";
import {
  AttachmentPreview,
  type ComposerContext,
  type ComposerDraft,
  ComposerDraftStore,
} from "./InputContext.tsx";
import { Markdown } from "./Markdown.tsx";
import { MentionEditor, type MentionEditorHandle } from "./MentionEditor.tsx";
import { ActionHint, CopyMessage, MessageAction, messageTime } from "./MessageActions.tsx";
import { Notice } from "./Notice.tsx";
import { reasoningDuration, reasoningSummary, runPresentation } from "./process-presentation.ts";
import { appendPromptHistory, readPromptHistory, savePromptHistory } from "./prompt-history.ts";
import { displayReferences, FileIcon, Reference } from "./Reference.tsx";
import { StreamEntrance } from "./StreamEntrance.tsx";
import { SubagentContext } from "./SubagentToolBlock.tsx";
import { SuggestionOptions } from "./SuggestionOptions.tsx";
import { filterSessionSuggestions } from "./session-suggestions.ts";
import { filterSkillSuggestions } from "./skill-suggestions.ts";
import { ToolBlock } from "./ToolBlock.tsx";
import { ToolGroup } from "./ToolGroup.tsx";
import { type ProcessItem, processItems } from "./tool-presentation.ts";
import { UserMessageBody } from "./UserMessageBody.tsx";
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
  suggestions,
  onFile,
}: {
  run: RunView;
  sessionId: string;
  context?: ComposerContext;
  onEdit: EditMessage;
  onCancel: () => void;
  suggestions?: InputSuggestion[];
  onFile?: FileOpenHandler;
}) {
  const storage = useRef(new ComposerDraftStore());
  const [conflict, setConflict] = useState<{ files: FileRewindConflict[]; input: MessageEditInput }>();
  const [resolving, setResolving] = useState(false);
  const report = (error: unknown) => {
    const draft = storage.current.get(sessionId);
    if (draft) storage.current.set(sessionId, { ...draft, error: userErrorMessage(error) });
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
        suggestions={suggestions}
        onFile={onFile}
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
  onFile?: FileOpenHandler;
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
        onLink={onLink}
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
            {block.text}
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
  previewServices,
  previewAutoOpen,
  onLink,
  workspace,
  expanded,
  onToggle,
  blocks,
  onBlockToggle,
  finding = false,
  context,
  readWebSourceIcon = context?.readWebSourceIcon,
  onChanges,
  onLoadToolPatch,
  onFileAction,
  onCopy,
  onFile,
  sessionId,
  onEdit,
  onFork,
  suggestions,
}: {
  suggestions?: InputSuggestion[];
  onEdit?: EditMessage;
  onFork?: (runId: string) => Promise<void>;
  run: RunView;
  previewServices?: PreviewServices;
  previewAutoOpen?: ReturnType<typeof usePreviewAutoOpen>;
  sessionId?: string;
  context?: ComposerContext;
  readWebSourceIcon?: ComposerContext["readWebSourceIcon"];
  onChanges?: (runId: string, path?: string, toolCallId?: string) => void;
  onLoadToolPatch?: (runId: string, toolCallId: string) => Promise<string>;
  onFileAction?: FileActionHandler;
  onCopy?: (text: string) => Promise<void>;
  onFile?: FileOpenHandler;
  workspace?: LinkContext;
  onLink: (url: string, options?: WebOpenOptions) => void;
  expanded: boolean;
  onToggle: (runId: string, value: boolean) => void;
  blocks: Record<string, boolean>;
  onBlockToggle: (blockId: string, value: boolean) => void;
  finding?: boolean;
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
  const commandNames = useMemo(() => customCommandNames(suggestions ?? []), [suggestions]);
  const agentNames = useMemo(() => subagentNames(suggestions ?? []), [suggestions]);
  useEffect(() => {
    if (!onEdit) setEditing(false);
  }, [onEdit]);
  const { process, answer, defaultOpen } = runPresentation(run);
  const answerSources = useMemo(() => collectAnswerSources(run, answer?.id), [run, answer?.id]);
  const latestText = run.orderedBlocks.findLast((block) => block.type === "text");
  const previews =
    previewServices && sessionId && workspace && latestText && run.status !== "running" ? (
      <AssistantTurnPreviews
        run={run}
        sessionId={sessionId}
        workspace={workspace}
        services={previewServices}
        autoOpen={previewAutoOpen}
      />
    ) : null;
  const markers = run.compactions ?? [];
  const compacting = markers.some((marker) => marker.status === "running");
  const items: (ProcessItem | { kind: "compaction"; id: string; marker: CompactionView })[] = [];
  let offset = 0;
  for (const marker of markers) {
    const index = marker.afterBlockId ? process.findIndex((block) => block.id === marker.afterBlockId) : -1;
    const boundary = Math.max(offset, index + 1);
    items.push(...processItems(process.slice(offset, boundary), false));
    items.push({ kind: "compaction", id: marker.id, marker });
    offset = boundary;
  }
  items.push(...processItems(process.slice(offset), run.status === "running" && !compacting));
  // 对齐 ZCode 后台结果轮：直接展示过程和正文，不再套普通回复的工时折叠。
  const open = !!run.subagentNotification || defaultOpen || expanded;
  if (run.kind === "compact")
    return (
      <div className="compaction-run" data-run-id={run.runId}>
        {(markers.length
          ? markers
          : [{ id: run.runId, status: run.status, origin: "manual" as const, error: run.error }]
        ).map((marker) => (
          <CompactionDivider key={marker.id} marker={marker} />
        ))}
      </div>
    );
  return (
    <article className="run-group" data-testid="run" data-run-id={run.runId} data-status={run.status}>
      <div className="assistant-turn">
        {run.subagentNotification ? (
          <div className="background-result-heading" data-testid="background-result-heading">
            {run.subagentNotification.description}
          </div>
        ) : (
          <div className="user-message-row">
            {editing && onEdit && sessionId ? (
              <UserMessageEditor
                run={run}
                sessionId={sessionId}
                context={context}
                suggestions={suggestions}
                onEdit={onEdit}
                onCancel={cancelEdit}
                onFile={onFile}
              />
            ) : (
              <>
                <div className="message-images">
                  <SelectionReferenceChip references={parsedUser.selections} onFile={onFile} />
                  {context &&
                    sessionId &&
                    run.attachments?.map((image) => (
                      <AttachmentPreview
                        key={image.id}
                        sessionId={sessionId}
                        image={image}
                        read={context.readAttachment}
                      />
                    ))}
                </div>
                <div className="user-message">
                  <UserMessageBody key={run.runId} text={run.userMessage}>
                    <div
                      className="user-message-text"
                      data-find-key={`${run.runId}:user`}
                      data-conversation-selectable="user"
                      data-selection-key={`${sessionId}:${run.runId}:user`}
                    >
                      {(() => {
                        const parts: ReactNode[] = [];
                        let previous = 0;
                        const mentions = displayReferences(parsedUser.text, commandNames, agentNames);
                        for (const mention of mentions) {
                          const file = mention.kind === "file" ? splitFileLocation(mention.path) : null;
                          parts.push(parsedUser.text.slice(previous, mention.start));
                          parts.push(
                            <Reference
                              key={mention.start}
                              kind={mention.kind}
                              path={file?.path ?? mention.path}
                              location={file?.location}
                              label={mention.label}
                              onOpen={onFile}
                              onAction={onFileAction}
                            />,
                          );
                          previous = mention.end;
                        }
                        parts.push(parsedUser.text.slice(previous));
                        for (const path of run.fileReferences ?? []) {
                          if (mentions.some((m) => m.path === path)) continue;
                          const file = splitFileLocation(path);
                          parts.push(
                            <Reference
                              key={path}
                              kind="file"
                              path={file?.path ?? path}
                              location={file?.location}
                              label={path.split("/").at(-1) ?? path}
                              onOpen={onFile}
                              onAction={onFileAction}
                            />,
                          );
                        }
                        return parts;
                      })()}
                    </div>
                  </UserMessageBody>
                </div>
                <div className="message-actions user-message-actions">
                  <CopyMessage text={parsedUser.text} onCopy={onCopy} />
                  {onEdit && (
                    <MessageAction label="编辑" onClick={() => setEditing(true)}>
                      <Pencil size={14} />
                    </MessageAction>
                  )}
                </div>
              </>
            )}
          </div>
        )}
        {!run.subagentNotification && (
          <WorkProgress
            run={run}
            expanded={open}
            defaultOpen={defaultOpen}
            toggle={() => {
              if (!defaultOpen) onToggle(run.runId, !expanded);
            }}
          />
        )}
        {open && items.length > 0 && (
          <div className="process" data-testid="process">
            {items.map((item) =>
              item.kind === "compaction" ? (
                <CompactionDivider key={item.id} marker={item.marker} />
              ) : item.kind !== "block" ? (
                <StreamEntrance
                  key={item.id}
                  id={`${sessionId}:${run.runId}:${item.id}`}
                  active={run.status === "running"}
                >
                  <ToolGroup
                    group={item}
                    blocks={blocks}
                    toggle={(id) => onBlockToggle(id, !(blocks[id] ?? false))}
                    workspace={workspace}
                    onCopy={onCopy}
                    onFile={onFile}
                    onChanges={onChanges ? openToolChange : undefined}
                    onLoadPatch={onLoadToolPatch ? loadToolPatch : undefined}
                  />
                </StreamEntrance>
              ) : (
                <Fragment key={item.id}>
                  <StreamEntrance
                    id={`${sessionId}:${run.runId}:${item.id}`}
                    active={run.status === "running" && item.block.type === "tool"}
                  >
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
                  </StreamEntrance>
                  {item.id === latestText?.id && previews}
                </Fragment>
              ),
            )}
          </div>
        )}
        {!open && finding && (
          // Search rendered assistant text independently of the work fold, without mounting hidden tools.
          <div hidden data-find-index>
            {process.map((block) =>
              block.type === "text" ? (
                <div key={block.id} data-find-key={block.id}>
                  <Markdown
                    text={block.text}
                    workspace={workspace}
                    streaming={false}
                    onLink={onLink}
                    onFile={onFile}
                  />
                </div>
              ) : null,
            )}
          </div>
        )}
        {!open && markers.map((marker) => <CompactionDivider key={marker.id} marker={marker} />)}
        {run.notice && (
          <div className="run-notice" role="status">
            {run.notice}
          </div>
        )}
        {run.status === "running" && !compacting && (
          <div
            className="chat-loading-slot"
            data-stream-entrance={run.preparation ? undefined : "true"}
            role="status"
            aria-label={run.preparation || (run.apiRetry?.attempt ? undefined : "加载中")}
          >
            {run.preparation ? (
              <span className="run-preparation" data-testid="run-preparation">
                <Loader className="chat-loading-spinner" size={16} aria-hidden="true" />
                {run.preparation}
              </span>
            ) : run.apiRetry && run.apiRetry.attempt > 0 ? (
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
        {run.error && run.status !== "running" && (
          <Notice scope="turn" message={userErrorMessage(run.error)} />
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
          {answer && previews}
          <ChangedFiles
            run={run}
            cwd={workspace?.cwd}
            onChanges={onChanges}
            onFile={onFile}
            onFileAction={onFileAction}
          />
          {answer && (
            <div className="message-actions assistant-message-actions">
              <CopyMessage text={answer.text} onCopy={onCopy} />
              {onFork && (
                <MessageAction
                  label="分叉"
                  disabled={forking}
                  onClick={() => {
                    setForking(true);
                    setActionError("");
                    void onFork(run.runId)
                      .catch((error) => setActionError(userErrorMessage(error)))
                      .finally(() => setForking(false));
                  }}
                >
                  <TrendingUpDown size={14} />
                </MessageAction>
              )}
              {answerSources.length > 0 && (
                <AnswerSources
                  key={JSON.stringify([sessionId, run.runId, answer.id])}
                  sources={answerSources}
                  sessionId={sessionId}
                  runId={run.runId}
                  readIcon={readWebSourceIcon}
                  onLink={onLink}
                />
              )}
              <span className="message-time">{messageTime(answer.startedAt ?? run.startedAt)}</span>
            </div>
          )}
          {actionError && <Notice scope="turn" message={actionError} />}
        </div>
      </div>
    </article>
  );
});
export function Conversation({
  view,
  onOpenSubagent,
  previewServices,
  onLink,
  workspace,
  context,
  readWebSourceIcon,
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
  addSelectionLabel,
  onSideChat,
  sideChatDisabled,
  onNavigateOrigin,
  findRequest,
  onFindStateChange,
  findBar,
  suggestions,
  persistReading = true,
}: {
  persistReading?: boolean;
  suggestions?: InputSuggestion[];
  onOpenSubagent?: (task: SubagentTask) => void;
  findRequest?: FindRequest;
  onFindStateChange?: (state: FindState) => void;
  findBar?: ReactNode;
  onNavigateOrigin?: (origin: NonNullable<SessionView["forkOrigin"]>) => void;
  onEdit?: EditMessage;
  onFork?: (runId: string) => Promise<void>;
  onAddSelection?: (reference: ConversationSelection) => void;
  addSelectionLabel?: string;
  onSideChat?: (reference: ConversationSelection) => void;
  sideChatDisabled?: boolean;
  hasEarlier?: boolean;
  loadingEarlier?: boolean;
  onLoadEarlier?: () => Promise<void>;
  historyCursor?: number | null;
  view: SessionView;
  previewServices?: PreviewServices;
  workspace?: LinkContext;
  onLink: (url: string, options?: WebOpenOptions) => void;
  context?: ComposerContext;
  readWebSourceIcon?: ComposerContext["readWebSourceIcon"];
  onChanges?: (runId: string, path?: string, toolCallId?: string) => void;
  onLoadToolPatch?: (runId: string, toolCallId: string) => Promise<string>;
  onFileAction?: FileActionHandler;
  onCopy?: (text: string) => Promise<void>;
  onFile?: FileOpenHandler;
}) {
  const previewAutoOpen = usePreviewAutoOpen(view);
  const subagentContext = useMemo(
    () => ({ tasks: view.subagents ?? [], open: onOpenSubagent }),
    [view.subagents, onOpenSubagent],
  );
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
  const navigateFind = useCallback((match: FindMatch, range?: Range) => {
    const root = ref.current;
    if (!root) return;
    if (!range) {
      const target = root.querySelector(`[data-find-key="${CSS.escape(match.key)}"]`);
      const runId = target?.closest<HTMLElement>("[data-run-id]")?.dataset.runId;
      if (runId) {
        following.current = false;
        setExpanded((current) => ({ ...current, [runId]: true }));
      }
      return;
    }
    following.current = false;
    const node = range.startContainer;
    const element = node instanceof Element ? node : node.parentElement;
    const content = element?.closest(".user-message-content-inner");
    const scroll = () => {
      const bounds = range.getBoundingClientRect();
      const viewport = root.getBoundingClientRect();
      root.scrollTo({
        top: root.scrollTop + bounds.top - viewport.top - root.clientHeight / 2 + bounds.height / 2,
        // ZCode first brings the target turn into view, then refines the visible hit smoothly.
        behavior: bounds.bottom < viewport.top || bounds.top > viewport.bottom ? "instant" : "smooth",
      });
    };
    if (content) {
      content.dispatchEvent(new Event("zpi-reveal-user-message"));
      requestAnimationFrame(scroll);
    } else scroll();
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
    void onLoadEarlier().catch((error) => setHistoryError(userErrorMessage(error)));
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
    window.addEventListener("zpi:scroll-to-run", navigate);
    return () => window.removeEventListener("zpi:scroll-to-run", navigate);
  }, [view.sessionId]);

  // An upward wheel gesture is reading intent; disabling following here wins the race
  // against the next stream chunk's stick-to-bottom snap reverting the user's scroll.
  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    const wheel = (event: WheelEvent) => {
      // At the top of the conversation an upward gesture has nothing to reveal.
      if (event.deltaY >= 0 || root.scrollTop <= 0) return;
      for (
        let node = event.target instanceof Element ? event.target : null;
        node && node !== root;
        node = node.parentElement
      ) {
        // An inner scroller still holding content consumes the gesture first.
        if (node.scrollTop > 0 && node.scrollHeight > node.clientHeight + 1) {
          const overflow = getComputedStyle(node).overflowY;
          if (overflow === "auto" || overflow === "scroll") return;
        }
      }
      following.current = false;
    };
    root.addEventListener("wheel", wheel, { passive: true });
    return () => root.removeEventListener("wheel", wheel);
  }, [view.sessionId]);

  const prepend = useRef<{ height: number; top: number; cursor: number | null | undefined } | null>(null);
  const historyTrigger = useRef<HTMLButtonElement>(null);
  const historyRequest = useRef<object | null>(null);
  const autoLoadAttempt = useRef("");
  const [historyError, setHistoryError] = useState("");
  const loadHistory = useCallback(() => {
    const el = ref.current;
    if (!el || !hasEarlier || loadingEarlier || !onLoadEarlier || historyRequest.current) return;
    const request = {};
    historyRequest.current = request;
    following.current = false;
    prepend.current = { height: el.scrollHeight, top: el.scrollTop, cursor: historyCursor };
    setHistoryError("");
    void onLoadEarlier()
      .catch((error) => {
        if (historyRequest.current !== request) return;
        prepend.current = null;
        setHistoryError(userErrorMessage(error));
      })
      .finally(() => {
        if (historyRequest.current === request) historyRequest.current = null;
      });
  }, [hasEarlier, loadingEarlier, onLoadEarlier, historyCursor]);
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
    if (!persistReading) return;
    const el = ref.current;
    if (!el) return;
    readingWrite.current = {
      key: `zpi.reading.${view.sessionId}`,
      value: JSON.stringify({ top: el.scrollTop, following: following.current, cursor: historyCursor ?? 0 }),
    };
    readingTimer.current ??= setTimeout(flushReading, 250);
  };
  useLayoutEffect(() => {
    let saved: { top: number; following: boolean } | undefined;
    try {
      if (persistReading)
        saved = JSON.parse(localStorage.getItem(`zpi.reading.${view.sessionId}`) ?? "null") ?? undefined;
    } catch {
      /* Invalid optional bookmark starts at latest. */
    }
    prepend.current = null;
    historyRequest.current = null;
    autoLoadAttempt.current = "";
    setHistoryError("");
    following.current = saved?.following ?? true;
    latestRun.current = view.runs.at(-1)?.runId;
    if (ref.current) ref.current.scrollTop = following.current ? ref.current.scrollHeight : (saved?.top ?? 0);
    const el = ref.current;
    lastScrollTop.current = el?.scrollTop ?? 0;
    setShowLatest(Boolean(el && el.scrollHeight - el.clientHeight - el.scrollTop >= 60));
    return flushReading;
  }, [view.sessionId, flushReading, persistReading]);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const tail = view.runs.at(-1)?.runId;
    if (tail !== latestRun.current) {
      latestRun.current = tail;
      if (!findQuery) following.current = true;
    }
    if (prepend.current && prepend.current.cursor !== historyCursor) {
      el.scrollTop = prepend.current.top + el.scrollHeight - prepend.current.height;
      lastScrollTop.current = el.scrollTop;
      prepend.current = null;
    } else if (following.current) scrollToBottom();
    setShowLatest(el.scrollHeight - el.scrollTop - el.clientHeight >= 60);
    saveReading();
  }, [view, historyCursor]);
  useEffect(() => {
    const root = ref.current;
    const trigger = historyTrigger.current;
    if (!root || !trigger || !hasEarlier || loadingEarlier) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        const attempt = `${view.sessionId}:${historyCursor}`;
        if (autoLoadAttempt.current === attempt || historyRequest.current) return;
        autoLoadAttempt.current = attempt;
        loadHistory();
      },
      { root, rootMargin: "120px 0px 0px 0px" },
    );
    observer.observe(trigger);
    return () => observer.disconnect();
  }, [view.sessionId, historyCursor, hasEarlier, loadingEarlier, loadHistory]);
  useLayoutEffect(() => {
    const root = ref.current;
    if (!root) return;
    const column = root.firstElementChild as HTMLElement | null;
    const owner = root.parentElement?.parentElement;
    const composer = owner?.querySelector(":scope > .composer-container");
    const shared = new Map<string, string>();
    const shareColumn = () => {
      if (!column || !owner || !composer) return;
      const width = column.getBoundingClientRect().width;
      if (!width) return;
      // A native scrollbar changes the available column width and its breakpoints.
      // Share layout bounds with the sibling composer, excluding visual translations.
      for (const [property, value] of [
        ["--conversation-column-width", `${width}px`],
        ["--conversation-column-left", getComputedStyle(column).marginLeft],
      ]) {
        if (owner.style.getPropertyValue(property) !== value) owner.style.setProperty(property, value);
        shared.set(property, value);
      }
    };
    shareColumn();
    const observer = new ResizeObserver(() => {
      shareColumn();
      const el = ref.current;
      if (!el) return;
      if (following.current) scrollToBottom();
      setShowLatest(el.scrollHeight - el.scrollTop - el.clientHeight >= 60);
    });
    observer.observe(root);
    if (column) observer.observe(column);
    return () => {
      observer.disconnect();
      for (const [property, value] of shared)
        if (owner?.style.getPropertyValue(property) === value) owner.style.removeProperty(property);
    };
  }, [view.sessionId]);
  return (
    <SubagentContext.Provider value={subagentContext}>
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
              const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
              if (el.scrollTop < lastScrollTop.current - 1 && distance >= 60) following.current = false;
              // Returning to the bottom resumes following. Only downward movement counts, so
              // momentum scrolling away from the bottom cannot re-snap mid-gesture.
              else if (el.scrollTop > lastScrollTop.current + 1 && distance <= 8) following.current = true;
              lastScrollTop.current = el.scrollTop;
              setShowLatest(distance >= 60);
              saveReading();
            }
          }}
        >
          <div className="conversation-inner">
            {hasEarlier && (
              <button
                ref={historyTrigger}
                className="load-history"
                disabled={loadingEarlier}
                onClick={loadHistory}
              >
                {loadingEarlier ? "正在加载…" : historyError ? "加载失败，点击重试" : "加载更早的十次调用"}
              </button>
            )}
            {historyError && <Notice scope="turn" message={historyError} />}
            {view.runs.length ? (
              view.runs.map((run) => (
                <Fragment key={run.runId}>
                  <RunGroup
                    suggestions={suggestions}
                    workspace={workspace}
                    key={run.runId}
                    run={run}
                    previewServices={previewServices}
                    previewAutoOpen={previewAutoOpen}
                    sessionId={view.sessionId}
                    context={context}
                    readWebSourceIcon={readWebSourceIcon}
                    onEdit={run.runId === view.runs.at(-1)?.runId ? onEdit : undefined}
                    onFork={onFork}
                    onChanges={onChanges}
                    onLoadToolPatch={onLoadToolPatch}
                    onFileAction={onFileAction}
                    onCopy={onCopy}
                    onFile={onFile}
                    onLink={onLink}
                    expanded={Boolean(expanded[run.runId])}
                    finding={Boolean(findQuery)}
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
        <ConversationSelectionMenu
          rootRef={ref}
          scopeKey={view.sessionId}
          onAdd={onAddSelection}
          addLabel={addSelectionLabel}
          onSideChat={onSideChat}
          sideChatDisabled={sideChatDisabled}
        />
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
    </SubagentContext.Provider>
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
  shortcutCommand,
  onSelectModel,
  onConfigureEnvironment,
}: {
  shortcutCommand?: (
    event: KeyboardEvent,
  ) => "send-next" | "select-model" | "configure-environment" | undefined;
  onSelectModel?: () => void;
  onConfigureEnvironment?: () => void;
  onCancel?: () => void;
  resetFiles?: { disabled: boolean; description: string };
  onFile?: FileOpenHandler;
  busy: boolean;
  onSubmit: (
    text: string,
    input: {
      fileReferences: string[];
      attachments: string[];
      queueDisposition?: "keep" | "clear";
      immediate?: boolean;
      workspaceMode?: "preserve" | "rewind";
    },
    context: { draftRevision: number },
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
  const [draggingFiles, setDraggingFiles] = useState(false);
  const dragDepth = useRef(0);
  useEffect(() => {
    setDraggingFiles(false);
    dragDepth.current = 0;
  }, [sessionId]);
  const [queueConfirmation, setQueueConfirmation] = useState(false);
  const submitLock = useRef(false);
  const queueSendLocks = useRef(new Set<string>());
  const composing = useRef(false);
  const textarea = useRef<MentionEditorHandle>(null);
  const root = useRef<HTMLFieldSetElement>(null);
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
    trigger: "/" | "$" | "#";
    query: string;
  }>();
  const dismissedInput = useRef<string | undefined>(undefined);
  const sessionsEnabled = inputQuery?.trigger === "#";
  const [sessionCatalog, setSessionCatalog] = useState<{
    id: string;
    items: SessionMentionSuggestion[];
    error?: string;
  }>();
  useEffect(() => {
    setSessionCatalog(undefined);
    if (!sessionsEnabled || !context?.listSessionMentions) return;
    let active = true;
    void context.listSessionMentions(sessionId).then(
      (items) => {
        if (active) setSessionCatalog({ id: sessionId, items });
      },
      (error) => {
        if (active) setSessionCatalog({ id: sessionId, items: [], error: userErrorMessage(error) });
      },
    );
    return () => {
      active = false;
    };
  }, [sessionsEnabled, sessionId, context]);
  const sessionLoading =
    sessionsEnabled && Boolean(context?.listSessionMentions) && sessionCatalog?.id !== sessionId;
  const sessionError = sessionsEnabled && sessionCatalog?.id === sessionId ? sessionCatalog.error : undefined;
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
            setFileError(userErrorMessage(e));
            setFileLoading(false);
          }
        });
    return () => {
      active = false;
    };
  }, [sessionId, fileQuery?.query, fileQuery?.explicit, context]);
  const insertFileMention = (
    file: { name: string; absolutePath: string; type: "file" | "directory" },
    start: number,
    end: number,
  ) => {
    const markdown = buildMentionMarkdown(
      file.name,
      file.absolutePath + (file.type === "directory" ? "/" : ""),
    );
    updateValue(sessionId, (old) => ({
      ...old,
      text: `${old.text.slice(0, start) + markdown} ${old.text.slice(end)}`,
      fileReferences: [],
    }));
    textarea.current?.focus();
    textarea.current?.setSelectionRange(start + markdown.length + 1, start + markdown.length + 1);
  };
  const chooseFile = (file: (typeof fileMatches)[number]) => {
    if (!fileQuery) return;
    insertFileMention(file, fileQuery.start, fileQuery.end);
    setFileQuery(undefined);
    setInputQuery(undefined);
  };
  const addAttachments = async (operation: () => Promise<import("zpi-coding-agent").Attachment[]>) => {
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
        throw new Error(attachmentLimitMessage);
      }
      updateValue(id, (old) => ({ ...old, attachments: [...old.attachments, ...images] }));
    } catch (e) {
      updateValue(id, (old) => ({ ...old, error: userErrorMessage(e) }));
    } finally {
      updateValue(id, (old) => ({ ...old, pending: Math.max(0, old.pending - 1) }));
    }
  };
  const importFiles = async (files: File[]) => {
    const imported: import("zpi-coding-agent").Attachment[] = [];
    if (!context) return imported;
    const id = sessionId;
    try {
      for (const file of files) imported.push(await context.importAttachment(id, file));
      return imported;
    } catch (error) {
      await Promise.all(imported.map((attachment) => context.removeAttachment(id, attachment.id)));
      throw error;
    }
  };
  const chooseAttachment = () => {
    setFileQuery(undefined);
    setInputQuery(undefined);
    const id = sessionId;
    if (context)
      void addAttachments(() => context.pickAttachments(id)).finally(() => {
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
  const commandNames = useMemo(() => customCommandNames(suggestions), [suggestions]);
  const agentNames = useMemo(() => subagentNames(suggestions), [suggestions]);
  const slash = useMemo(
    () => slashSuggestions(suggestions, inputQuery?.query ?? ""),
    [suggestions, inputQuery?.query],
  );
  const matches = useMemo(
    () =>
      inputQuery
        ? inputQuery.trigger === "#"
          ? filterSessionSuggestions(
              sessionCatalog?.id === sessionId ? sessionCatalog.items : [],
              inputQuery.query,
            )
          : inputQuery.trigger === "$"
            ? filterSkillSuggestions(suggestions, inputQuery.query)
            : slash.options
        : [],
    [inputQuery, suggestions, sessionCatalog, sessionId, slash],
  );
  useLayoutEffect(() => {
    if (inputQuery?.trigger === "/") setHighlighted(slash.selectedIndex);
  }, [inputQuery?.trigger, slash]);
  const menuOpen = Boolean(inputQuery);
  const insert = (suggestion: InputSuggestion) => {
    if (!inputQuery) return;
    const { start } = inputQuery;
    const end =
      inputQuery.trigger === "/"
        ? slashTokenEnd(draft, inputQuery.end, inputQuery.query, suggestion.name)
        : inputQuery.end;
    const inserted = suggestion.insert;
    updateDraft(draft.slice(0, start) + inserted + draft.slice(end));
    setInputQuery(undefined);
    dismissedInput.current = undefined;
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
    dismissedInput.current = undefined;
    currentWorkspace.current = workspace;
    promptHistory.current = readPromptHistory(workspace, sentMessages);
    recalled.current = null;
  }, [sessionId, workspace]);
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      if (
        Array.from(
          document.querySelectorAll<HTMLElement>(
            'dialog[open], [role="dialog"], [role="menu"], [role="listbox"], .settings-screen',
          ),
        ).some(
          (element) =>
            !element.closest('[hidden], [inert], [aria-hidden="true"]') &&
            element.getClientRects().length > 0 &&
            !["hidden", "collapse"].includes(getComputedStyle(element).visibility),
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
  const submit = async (
    queueDisposition?: "keep" | "clear",
    workspaceMode?: "preserve" | "rewind",
    immediate = false,
  ) => {
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
      const result = await onSubmit(
        buildSelectionPrompt(submitted.text, submitted.selections ?? []),
        {
          ...(workspaceMode ? { workspaceMode } : {}),
          ...(queueDisposition ? { queueDisposition } : {}),
          ...(immediate ? { immediate } : {}),
          fileReferences: [
            ...new Set([
              ...submitted.fileReferences,
              ...parseMentions(submitted.text)
                .filter((m) => m.kind === "file")
                .map((m) => m.path),
            ]),
          ],
          attachments: submitted.attachments.map((e) => e.id),
        },
        { draftRevision: submittedRevision },
      );
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
      drafts.current.set(id, restored);
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
  const sendQueuedNow = async (itemId: string) => {
    const id = sessionId;
    if (!queueActions || editing || submitLock.current || queueSendLocks.current.has(id)) return;
    queueSendLocks.current.add(id);
    try {
      await queueActions.sendNow(itemId);
    } finally {
      queueSendLocks.current.delete(id);
    }
  };
  return (
    <form
      onSubmit={(event) => event.preventDefault()}
      className={`composer-stack${header ? " with-header" : ""}`}
      onKeyDownCapture={(event) => {
        // Capture before the editor's Enter handling. Portal menus belong to the
        // React tree too, but only keys from this focused composer are commands.
        if (
          event.defaultPrevented ||
          composing.current ||
          event.nativeEvent.isComposing ||
          event.keyCode === 229 ||
          !root.current?.contains(event.target as Node) ||
          !root.current.contains(document.activeElement)
        )
          return;
        const command = shortcutCommand?.(event.nativeEvent);
        if (!command) return;
        event.preventDefault();
        event.stopPropagation();
        if (event.repeat) return;
        if (command === "select-model") onSelectModel?.();
        else if (command === "configure-environment") onConfigureEnvironment?.();
        else if (hasDraft) void submit(undefined, undefined, true);
        else {
          const first = queue?.items[0];
          if (first?.state === "queued")
            void sendQueuedNow(first.id).catch((error) =>
              updateValue(sessionId, (old) => ({ ...old, error: userErrorMessage(error) })),
            );
        }
      }}
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
          actions={{ ...queueActions, edit: editQueued, sendNow: sendQueuedNow }}
          onError={(error) => updateValue(sessionId, (old) => ({ ...old, error: userErrorMessage(error) }))}
        />
      )}
      <fieldset
        className={`composer${draggingFiles ? " dragging-files" : ""}`}
        ref={root}
        aria-label="输入消息"
        onDragEnter={(event) => {
          if (!context || editing || !event.dataTransfer.types.includes("Files")) return;
          event.preventDefault();
          dragDepth.current += 1;
          setDraggingFiles(true);
        }}
        onDragLeave={() => {
          dragDepth.current = Math.max(0, dragDepth.current - 1);
          if (!dragDepth.current) setDraggingFiles(false);
        }}
        onDragOver={(event) => {
          if (
            context &&
            (event.dataTransfer.types.includes("Files") ||
              event.dataTransfer.types.includes("application/x-zpi-workspace-file"))
          )
            event.preventDefault();
        }}
        onDrop={(event) => {
          dragDepth.current = 0;
          setDraggingFiles(false);
          if (!context || editing) return;
          const workspaceFile = event.dataTransfer.getData("application/x-zpi-workspace-file");
          if (workspaceFile) {
            event.preventDefault();
            try {
              const file = JSON.parse(workspaceFile);
              if (
                typeof file.path !== "string" ||
                !file.path ||
                file.path.includes("\0") ||
                typeof file.name !== "string" ||
                !["file", "directory"].includes(file.type)
              )
                return;
              const start = textarea.current?.selectionStart ?? draft.length;
              const end = textarea.current?.selectionEnd ?? start;
              insertFileMention({ name: file.name, absolutePath: file.path, type: file.type }, start, end);
            } catch {
              /* Ignore malformed drag data from another application. */
            }
            return;
          }
          const files = Array.from(event.dataTransfer.files);
          if (!files.length) return;
          event.preventDefault();
          setFileQuery(undefined);
          setInputQuery(undefined);
          const id = sessionId;
          void addAttachments(() => importFiles(files)).finally(() => {
            if (currentSession.current === id) textarea.current?.focus();
          });
        }}
      >
        {draggingFiles && (
          <div className="composer-drop-overlay" role="status">
            <div>
              <Hand size={16} aria-hidden="true" />
              <span>松开以添加附件</span>
            </div>
          </div>
        )}
        <div className="input-context">
          {context && value.attachments.length > 0 && (
            <div className="input-context-row" data-composer-file-attachments-row="">
              {value.attachments.map((image) => (
                <AttachmentPreview
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
                      .catch((e) =>
                        updateValue(sessionId, (old) => ({ ...old, error: userErrorMessage(e) })),
                      );
                  }}
                />
              ))}
            </div>
          )}
          {Boolean(value.selections?.length) && (
            <div className="input-context-row" data-composer-context-attachments-row="">
              <SelectionReferenceChip
                references={value.selections ?? []}
                onCommentsEmpty={() => textarea.current?.focus()}
                onFile={onFile}
                onChange={(selections) => updateValue(sessionId, (old) => ({ ...old, selections }))}
              />
            </div>
          )}
        </div>
        {value.pending > 0 && <small role="status">正在处理附件…</small>}
        {value.error && (
          <Notice
            scope="input"
            message={userErrorMessage(value.error)}
            onDismiss={() => updateValue(sessionId, (old) => ({ ...old, error: undefined }))}
          />
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
          <div
            className={`command-panel${inputQuery?.trigger === "$" ? " skill-panel" : sessionsEnabled ? " session-panel" : " slash-panel"}`}
          >
            <SuggestionOptions
              selectedIndex={highlighted}
              options={matches}
              label={sessionsEnabled ? "会话" : inputQuery?.trigger === "$" ? "技能" : "指令"}
            >
              {sessionError && <p role="alert">{sessionError}</p>}
              {sessionLoading && <p role="status">正在加载…</p>}
              {!matches.length && inputQuery?.trigger !== "/" && !sessionError && !sessionLoading && (
                <p>
                  {sessionsEnabled
                    ? "没有匹配的近期会话"
                    : `暂无匹配${inputQuery?.trigger === "$" ? "技能" : "指令"}`}
                </p>
              )}
              {(inputQuery?.trigger === "/"
                ? slash.sections
                : [{ label: "", options: matches, offset: 0 }]
              ).map((section) => (
                <Fragment key={section.label}>
                  {section.label && <div className="command-section-title">{section.label}</div>}
                  {section.label && !section.options.length && <p>暂无匹配{section.label}</p>}
                  {section.options.map((suggestion, index) => (
                    <button
                      key={`${suggestion.group}:${suggestion.insert}`}
                      type="button"
                      role="option"
                      aria-selected={section.offset + index === highlighted}
                      title={
                        suggestion.argumentHint ? `/${suggestion.name} ${suggestion.argumentHint}` : undefined
                      }
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => insert(suggestion)}
                    >
                      {inputQuery?.trigger === "#" ? (
                        <MessagesSquare size={14} aria-hidden="true" />
                      ) : inputQuery?.trigger === "$" ? (
                        <WandSparkles size={14} aria-hidden="true" />
                      ) : null}
                      <strong>
                        {inputQuery?.trigger === "/" ? slashSuggestionLabel(suggestion) : suggestion.name}
                      </strong>
                      <span>{suggestion.description}</span>
                    </button>
                  ))}
                </Fragment>
              ))}
            </SuggestionOptions>
            {!inputQuery?.query && (
              <div className="command-hint">
                <Info size={16} aria-hidden="true" />
                输入内容以搜索{sessionsEnabled ? "近期会话" : inputQuery?.trigger === "$" ? "技能" : "指令"}
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
          onFile={(path) => {
            const file = splitFileLocation(path);
            onFile?.(file?.path ?? path, file?.location);
          }}
          history={drafts.current.history(sessionId)}
          initialSelection={value.selection}
          onSelection={(selection) =>
            updateValue(sessionId, (old) => {
              if (old.selection?.[0] === selection[0] && old.selection?.[1] === selection[1]) return old;
              return { ...old, selection };
            })
          }
          value={draft}
          commandNames={commandNames}
          subagentNames={agentNames}
          onBlur={() => {
            setInputQuery(undefined);
            dismissedInput.current = undefined;
          }}
          disabled={editing}
          placeholder={busy ? "继续输入以排队后续修改" : sentMessages.length ? "提出后续修改要求" : undefined}
          onPaste={(e) => {
            if (!context) return;
            const images = Array.from(e.clipboardData.items)
              .filter((item) => item.kind === "file")
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
            void addAttachments(() => importFiles(images));
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
            setFileQuery(context ? fileMentionQuery(prefix) : undefined);
            const command =
              /(?:^|\s)(\/)([^\s@$#¥￥]*)$/.exec(prefix) ?? /(?:^|\s)([$#¥￥])([^\s/@$#¥￥]*)$/.exec(prefix);
            const signature = command ? `${command[1]}:${command[2]}` : undefined;
            if (signature !== dismissedInput.current) dismissedInput.current = undefined;
            setInputQuery(
              command && (!signature || signature !== dismissedInput.current)
                ? {
                    start: caret - command[2].length - 1,
                    end: caret,
                    trigger: command[1] === "/" ? "/" : command[1] === "#" ? "#" : "$",
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
                if (inputQuery) dismissedInput.current = `${inputQuery.trigger}:${inputQuery.query}`;
                setFileQuery(undefined);
                setInputQuery(undefined);
                return;
              }
              if (options.length && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
                e.preventDefault();
                setHighlighted((n) => {
                  const next = n + (e.key === "ArrowDown" ? 1 : -1);
                  return inputQuery?.trigger === "/"
                    ? Math.max(0, Math.min(next, options.length - 1))
                    : (next + options.length) % options.length;
                });
                return;
              }
              if (
                options.length &&
                ((e.key === "Enter" && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) ||
                  e.key === "Tab")
              ) {
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
            if (e.key === "Enter" && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey && !isComposing) {
              e.preventDefault();
              void submit();
            }
          }}
        />
        <div className="composer-footer">
          <ActionHint label="添加上下文" appearance="control" open={fileQuery?.explicit ? false : undefined}>
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
          </ActionHint>
          <div className="composer-actions">
            {toolbar}
            {onCancel && (
              <MessageAction label="取消" disabled={submitting} onClick={onCancel}>
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
              <ActionHint label="停止生成" appearance="control">
                <button type="button" className="send stop" aria-label="停止" onClick={onStop}>
                  <Square size={16} fill="currentColor" />
                </button>
              </ActionHint>
            ) : showSendButton || busy ? (
              <ActionHint label={busy ? "加入队列" : "发送"} appearance="control">
                <button
                  className="send"
                  aria-label={busy ? "加入队列" : "发送"}
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
              </ActionHint>
            ) : null}
          </div>
        </div>
      </fieldset>
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
