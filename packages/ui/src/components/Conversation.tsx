import * as Menu from "@radix-ui/react-dropdown-menu";
import {
  ArrowDown,
  ArrowUp,
  Brain,
  ChevronRight,
  FileCode2,
  ImagePlus,
  Info,
  type LucideIcon,
  Pencil,
  Plus,
  Search,
  Square,
  SquareTerminal,
  Wrench,
} from "lucide-react";
import type { ReactNode } from "react";
import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { buildMentionMarkdown, imageLimits, parseMentions } from "zpi-coding-agent/input";
import type { FileLocation, LinkContext, WebOpenOptions } from "../link-target.ts";
import { progressSummary } from "../reducer.ts";
import type { InputQueue, InputSuggestion, RunView, SessionView, ViewBlock } from "../types.ts";
import { ConversationQueuePanel, type QueueActions } from "./ConversationQueuePanel.tsx";
import { DraftGreeting } from "./DraftGreeting.tsx";
import {
  type ComposerContext,
  type ComposerDraft,
  ComposerDraftStore,
  ImagePreview,
} from "./InputContext.tsx";
import { Markdown } from "./Markdown.tsx";
import { MentionEditor, type MentionEditorHandle } from "./MentionEditor.tsx";
import { reasoningSummary, workDuration } from "./process-presentation.ts";
import { appendPromptHistory, readPromptHistory, savePromptHistory } from "./prompt-history.ts";
import { displayReferences, FileIcon, Reference, referenceStyle } from "./Reference.tsx";
import { ToolFailure } from "./ToolFailure.tsx";

const processTools: Record<string, { icon: LucideIcon; label: string }> = {
  read: { icon: Search, label: "读取" },
  bash: { icon: SquareTerminal, label: "终端" },
  write: { icon: Pencil, label: "写入" },
  edit: { icon: Pencil, label: "编辑" },
};

function toolCommand(block: Extract<ViewBlock, { type: "tool" }>): string {
  try {
    const args: unknown = JSON.parse(block.argsText);
    if (args && typeof args === "object") {
      const value = args as Record<string, unknown>;
      if (block.name === "bash" && typeof value.command === "string") return value.command;
      if (typeof value.path === "string") return value.path;
    }
  } catch {
    /* Partial arguments are not a command yet. */
  }
  return block.status === "preparing" ? "正在准备参数…" : block.name;
}
function ProcessBlock({
  block,
  expanded,
  toggle,
  onLink,
  workspace,
  onCopy,
  onFile,
  onImage,
  onDownloadImage,
}: {
  onImage?: (path: string, location?: FileLocation) => Promise<string>;
  onDownloadImage?: (src: string) => Promise<void>;
  block: ViewBlock;
  onFile?: (path: string, location?: FileLocation) => void;
  expanded: boolean;
  toggle: () => void;
  workspace?: LinkContext;
  onLink: (url: string, options?: WebOpenOptions) => void;
  onCopy?: (text: string) => Promise<void>;
}) {
  const output = useRef<HTMLPreElement>(null);
  const summary = useRef<HTMLSpanElement>(null);
  const streamingSummary =
    block.type === "thinking" && block.streaming && !expanded ? reasoningSummary(block.text) : "";
  const following = useRef(true);
  useLayoutEffect(() => {
    if (summary.current) summary.current.scrollLeft = summary.current.scrollWidth;
  }, [streamingSummary]);
  useEffect(() => {
    if (following.current && output.current) output.current.scrollTop = output.current.scrollHeight;
  }, [block, expanded]);
  if (block.type === "tool") {
    const command = toolCommand(block);
    const lines = command.split(/\r?\n/);
    const { icon: Icon, label } = processTools[block.name] ?? { icon: Wrench, label: block.name || "工具" };
    return (
      <div className="tool-block" data-testid="tool-block" data-tool-name={block.name}>
        <div className="tool-summary-row">
          <button
            className="block-toggle tool-title"
            aria-expanded={expanded}
            onClick={toggle}
            title={`${block.name} · ${command}`}
          >
            <Icon size={16} aria-hidden="true" className="process-icon" />
            <strong>{label}</strong>
            {(!expanded || block.name !== "bash") && (
              <span className="block-summary">
                {lines[0]}
                {lines.length > 1 ? " …" : ""}
              </span>
            )}
            <ChevronRight
              size={16}
              aria-hidden="true"
              className={`process-chevron ${expanded ? "rotated" : ""}`}
            />
          </button>
          {block.status === "error" && <ToolFailure text={block.output || "工具执行失败"} onCopy={onCopy} />}
        </div>
        {expanded && (
          <div className="tool-details">
            <div className="tool-command-line">
              {block.name === "bash" && (
                <span className="tool-prompt" aria-hidden="true">
                  $
                </span>
              )}
              <pre className="tool-command">{block.name === "bash" ? command : block.argsText}</pre>
            </div>
            {block.output && (
              <pre
                ref={output}
                className="tool-output"
                onScroll={() => {
                  const el = output.current;
                  if (el) following.current = el.scrollHeight - el.clientHeight - el.scrollTop < 24;
                }}
              >
                {block.output}
              </pre>
            )}
          </div>
        )}
      </div>
    );
  }
  if (block.type === "thinking") {
    const duration =
      !block.streaming && block.startedAt !== undefined && block.endedAt !== undefined
        ? workDuration(block.endedAt - block.startedAt)
        : "";
    return (
      <div className="process-thinking" data-testid="thinking-block">
        <button className="block-toggle" aria-expanded={expanded} onClick={toggle}>
          <Brain size={16} aria-hidden="true" className="process-icon" />
          <strong>{block.streaming ? "正在思考" : "思考"}</strong>
          {(streamingSummary || duration) && <span className="process-separator">·</span>}
          {streamingSummary ? (
            <span ref={summary} className="block-summary thinking-summary">
              {streamingSummary}
            </span>
          ) : duration ? (
            <span className="reasoning-duration">{duration}</span>
          ) : null}
          <ChevronRight
            size={16}
            aria-hidden="true"
            className={`process-chevron ${expanded ? "rotated" : ""}`}
          />
        </button>
        {expanded && <pre className="thinking-body">{block.text}</pre>}
      </div>
    );
  }
  return (
    <div className="process-text answer">
      <Markdown
        workspace={workspace}
        onImage={onImage}
        onDownloadImage={onDownloadImage}
        text={block.text}
        streaming={Boolean(block.streaming)}
        onLink={onLink}
        onCopy={onCopy}
        onFile={onFile}
      />
    </div>
  );
}
const WorkProgress = memo(function WorkProgress({
  run,
  expanded,
  toggle,
}: {
  run: RunView;
  expanded: boolean;
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
        <ChevronRight size={16} aria-hidden="true" className={expanded ? "rotated" : ""} />
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
  onCopy,
  onFile,
  sessionId,
}: {
  run: RunView;
  sessionId?: string;
  context?: ComposerContext;
  onChanges?: (runId: string, path?: string) => void;
  onCopy?: (text: string) => Promise<void>;
  onFile?: (path: string, location?: FileLocation) => void;
  workspace?: LinkContext;
  onLink: (url: string, options?: WebOpenOptions) => void;
  expanded: boolean;
  onToggle: (runId: string, value: boolean) => void;
  blocks: Record<string, boolean>;
  onBlockToggle: (blockId: string, value: boolean) => void;
}) {
  const onImage = useCallback(
    (path: string, location?: FileLocation) =>
      context?.readImage && sessionId
        ? context.readImage(sessionId, path, location)
        : Promise.reject(new Error("图片预览不可用")),
    [context, sessionId],
  );
  const process = run.orderedBlocks.filter((b) => !run.finalAnswerBlockIds.includes(b.id));
  return (
    <article className="run-group" data-testid="run" data-status={run.status}>
      <div className="user-message">
        <div className="message-images">
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
        <div className="user-message-text">
          {(() => {
            const parts: ReactNode[] = [];
            let previous = 0;
            const mentions = displayReferences(run.userMessage);
            for (const mention of mentions) {
              parts.push(run.userMessage.slice(previous, mention.start));
              parts.push(
                <Reference
                  key={mention.start}
                  kind={mention.kind}
                  path={mention.path}
                  label={mention.label}
                  onOpen={onFile}
                />,
              );
              previous = mention.end;
            }
            parts.push(run.userMessage.slice(previous));
            for (const path of run.fileReferences ?? [])
              if (!mentions.some((m) => m.path === path))
                parts.push(
                  <Reference
                    key={path}
                    kind="file"
                    path={path}
                    label={path.split("/").at(-1) ?? path}
                    onOpen={onFile}
                  />,
                );
            return parts;
          })()}
        </div>
      </div>
      <WorkProgress run={run} expanded={expanded} toggle={() => onToggle(run.runId, !expanded)} />
      {expanded && (
        <div className="process" data-testid="process">
          {process.map((b) => (
            <ProcessBlock
              workspace={workspace}
              key={b.id}
              onImage={onImage}
              onDownloadImage={context?.downloadImage}
              block={b}
              expanded={blocks[b.id] ?? false}
              toggle={() => onBlockToggle(b.id, !(blocks[b.id] ?? false))}
              onLink={onLink}
              onCopy={onCopy}
              onFile={onFile}
            />
          ))}
        </div>
      )}
      {run.notice && (
        <div className="run-notice" role="status">
          {run.notice}
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
      <div className="answer">
        {run.orderedBlocks
          .filter((b) => run.finalAnswerBlockIds.includes(b.id) && b.type === "text")
          .map((b) => (
            <Markdown
              workspace={workspace}
              key={b.id}
              onImage={onImage}
              onDownloadImage={context?.downloadImage}
              text={b.type === "text" ? b.text : ""}
              streaming={run.status === "running"}
              onLink={onLink}
              onCopy={onCopy}
              onFile={onFile}
            />
          ))}
      </div>
      <div className="changed-files">
        {run.orderedBlocks.some((block) => block.type === "tool" && block.fileChange) && (
          <span className="changed-files-label">变更的文件</span>
        )}
        {Array.from(
          new Set(
            run.orderedBlocks.flatMap((b) => (b.type === "tool" && b.fileChange ? [b.fileChange.path] : [])),
          ),
        ).map((path) => {
          const changes = run.orderedBlocks.flatMap((b) =>
            b.type === "tool" && b.fileChange?.path === path ? [b.fileChange] : [],
          );
          const known = changes.every((c) => c.additions !== undefined && c.deletions !== undefined);
          const additions = changes.reduce((sum, c) => sum + (c.additions ?? 0), 0),
            deletions = changes.reduce((sum, c) => sum + (c.deletions ?? 0), 0);
          return (
            <button
              type="button"
              className="changed-file-card"
              key={path}
              onClick={() => onChanges?.(run.runId, path)}
              title={`${path}${changes.length > 1 ? "\n多次工具修改的累计行数" : ""}`}
              aria-label={`查看修改 ${path.split("/").at(-1)}`}
            >
              <FileIcon path={path} size={15} />
              <span className="changed-file-info">
                <strong>{path.split("/").at(-1)}</strong>
                <span className="changed-file-counts">
                  {known ? (
                    <>
                      <span className="diff-added">+{additions}</span>
                      <span className="diff-removed">−{deletions}</span>
                    </>
                  ) : (
                    <span>无法统计行数</span>
                  )}
                  {changes.some((c) => c.failed) && <span>部分修改失败</span>}
                </span>
              </span>
            </button>
          );
        })}
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
  onCopy,
  onFile,
  hasEarlier = false,
  loadingEarlier = false,
  onLoadEarlier,
  historyCursor,
}: {
  hasEarlier?: boolean;
  loadingEarlier?: boolean;
  onLoadEarlier?: () => Promise<void>;
  historyCursor?: number | null;
  view: SessionView;
  workspace?: LinkContext;
  onLink: (url: string, options?: WebOpenOptions) => void;
  context?: ComposerContext;
  onChanges?: (runId: string, path?: string) => void;
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
        else if (
          next[run.runId] === undefined &&
          run.status === "running" &&
          run.orderedBlocks.some((b) => b.type === "thinking" && b.streaming)
        )
          next[run.runId] = true;
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
  const scrollToBottom = () => {
    const el = ref.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    lastScrollTop.current = el.scrollTop;
  };
  const [showLatest, setShowLatest] = useState(false);
  const prepend = useRef<{ height: number; top: number } | null>(null);
  const saveReading = () => {
    const el = ref.current;
    if (el)
      localStorage.setItem(
        `zpi.reading.${view.sessionId}`,
        JSON.stringify({ top: el.scrollTop, following: following.current, cursor: historyCursor ?? 0 }),
      );
  };
  useLayoutEffect(() => {
    let saved: { top: number; following: boolean } | undefined;
    try {
      saved = JSON.parse(localStorage.getItem(`zpi.reading.${view.sessionId}`) ?? "null") ?? undefined;
    } catch {
      /* Invalid optional bookmark starts at latest. */
    }
    following.current = saved?.following ?? true;
    latestRun.current = view.runs.at(-1)?.runId;
    if (ref.current) ref.current.scrollTop = following.current ? ref.current.scrollHeight : (saved?.top ?? 0);
    const el = ref.current;
    lastScrollTop.current = el?.scrollTop ?? 0;
    setShowLatest(Boolean(el && el.scrollHeight - el.clientHeight - el.scrollTop >= 60));
  }, [view.sessionId]);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const tail = view.runs.at(-1)?.runId;
    if (tail !== latestRun.current) {
      latestRun.current = tail;
      following.current = true;
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
              <RunGroup
                workspace={workspace}
                key={run.runId}
                run={run}
                sessionId={view.sessionId}
                context={context}
                onChanges={onChanges}
                onCopy={onCopy}
                onFile={onFile}
                onLink={onLink}
                expanded={expanded[run.runId] ?? false}
                onToggle={toggle}
                blocks={blocks}
                onBlockToggle={toggleBlock}
              />
            ))
          ) : (
            <div className="empty-chat">
              <DraftGreeting />
            </div>
          )}
        </div>
      </div>
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
}: {
  onFile?: (path: string, location?: FileLocation) => void;
  busy: boolean;
  onSubmit: (
    text: string,
    input: { fileReferences: string[]; attachments: string[]; queueDisposition?: "keep" | "clear" },
  ) => Promise<void> | Promise<"confirmationRequired" | undefined>;
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
  const [fileMatches, setFileMatches] = useState<{ path: string; name: string; absolutePath: string }[]>([]);
  const [fileError, setFileError] = useState("");
  useEffect(() => {
    let active = true;
    setFileMatches([]);
    setFileError("");
    if (fileQuery && context)
      void context
        .searchFiles(sessionId, fileQuery.query)
        .then((files) => {
          if (active) setFileMatches(files);
        })
        .catch((e) => {
          if (active) setFileError(String(e));
        });
    return () => {
      active = false;
    };
  }, [sessionId, fileQuery?.query, fileQuery?.explicit, context]);
  const chooseFile = (file: { path: string; name: string; absolutePath: string }) => {
    const range = fileQuery;
    if (!range) return;
    const markdown = buildMentionMarkdown(file.name, file.absolutePath);
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
  const addImages = async (operation: () => Promise<import("zpi-coding-agent").ImageAttachment[]>) => {
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
  const currentSession = useRef(sessionId);
  const [highlighted, setHighlighted] = useState(0);
  const matches = inputQuery
    ? suggestions.filter(
        (suggestion) =>
          (inputQuery.trigger === "$"
            ? suggestion.group === "Skill"
            : suggestion.group === "命令" && ["init", "compact"].includes(suggestion.name)) &&
          suggestion.name.toLowerCase().includes(inputQuery.query.toLowerCase()),
      )
    : [];
  const menuOpen = Boolean(inputQuery);
  const insert = (suggestion: InputSuggestion) => {
    if (!inputQuery) return;
    const { start, end } = inputQuery;
    const inserted = suggestion.insert;
    updateDraft(draft.slice(0, start) + inserted + draft.slice(end));
    setInputQuery(undefined);
    requestAnimationFrame(() => {
      textarea.current?.focus();
      textarea.current?.setSelectionRange(start + inserted.length, start + inserted.length);
    });
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
      if (e.target instanceof Node && !root.current?.contains(e.target)) {
        setInputQuery(undefined);
        setFileQuery(undefined);
      }
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, []);
  const hasDraft = Boolean(
    draft.trim() || value.attachments.length || value.fileReferences.length || value.pending,
  );
  const submit = async (queueDisposition?: "keep" | "clear") => {
    if (
      editing ||
      submitLock.current ||
      drafts.current.submitting.has(sessionId) ||
      submitting ||
      value.pending ||
      (!draft.trim() && !value.attachments.length && !value.fileReferences.length)
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
      const result = await onSubmit(submitted.text, {
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
          JSON.stringify(current.fileReferences) === JSON.stringify(submitted.fileReferences);
        const usedImages = new Set(submitted.attachments.map((image) => image.id));
        const next = {
          ...current,
          error: undefined,
          ...(unchanged ? { text: "", fileReferences: [], selection: [0, 0] as [number, number] } : {}),
          attachments: current.attachments.filter((image) => !usedImages.has(image.id)),
        };
        drafts.current.set(submittedSession, next);
        if (unchanged) drafts.current.history(submittedSession).clear();
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
      (current.text.trim() || current.fileReferences.length || current.attachments.length || current.pending)
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
  return (
    <div className={`composer-stack${header ? " with-header" : ""}`}>
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
            className="command-panel"
            role="listbox"
            aria-label="引用文件"
            tabIndex={-1}
            ref={(element) => {
              if (fileQuery.explicit) element?.focus();
            }}
            onKeyDown={(e) => {
              if (!fileQuery.explicit || e.nativeEvent.isComposing || e.keyCode === 229) return;
              if (e.key === "Escape") {
                e.preventDefault();
                setFileQuery(undefined);
                textarea.current?.focus();
              } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                e.preventDefault();
                setHighlighted(
                  (n) =>
                    (n + (e.key === "ArrowDown" ? 1 : -1) + fileMatches.length) %
                    Math.max(fileMatches.length, 1),
                );
              } else if (e.key === "Enter" || e.key === "Tab" || e.key === " ") {
                e.preventDefault();
                const file = fileMatches[highlighted] ?? fileMatches[0];
                if (file) chooseFile(file);
              }
            }}
          >
            <div className="command-options">
              <h3>文件</h3>
              {fileError && <p role="alert">{fileError}</p>}
              {fileMatches.map((file, i) => (
                <button
                  type="button"
                  role="option"
                  aria-selected={i === highlighted}
                  key={file.path}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => chooseFile(file)}
                >
                  <FileIcon path={file.path} />
                  <strong>{file.name}</strong>
                  {file.path !== file.name && <span>{file.path}</span>}
                </button>
              ))}
              {!fileMatches.length && !fileError && <p>暂无匹配文件</p>}
            </div>
            {!fileQuery.query && (
              <div className="command-hint">
                <Info size={16} aria-hidden="true" />
                在输入框中输入 @ 搜索文件
              </div>
            )}
          </div>
        )}
        {menuOpen && !fileQuery && (
          <div className="command-panel">
            <div
              className="command-options"
              role="listbox"
              aria-label={inputQuery?.trigger === "$" ? "技能" : "指令"}
            >
              <h3>{inputQuery?.trigger === "$" ? "技能" : "指令"}</h3>
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
            </div>
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
            if (text) updateDraft(draft.slice(0, start) + text + draft.slice(end));
            void addImages(async () => {
              const imported: import("zpi-coding-agent").ImageAttachment[] = [];
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
            if (!composing.current && !e.nativeEvent.isComposing && e.keyCode !== 229 && fileQuery) {
              if (e.key === "Escape") {
                e.preventDefault();
                setFileQuery(undefined);
                return;
              }
              if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                e.preventDefault();
                setHighlighted(
                  (n) =>
                    (n + (e.key === "ArrowDown" ? 1 : -1) + fileMatches.length) %
                    Math.max(fileMatches.length, 1),
                );
                return;
              }
              if ((e.key === "Enter" && !e.shiftKey) || e.key === "Tab") {
                e.preventDefault();
                const file = fileMatches[highlighted] ?? fileMatches[0];
                if (file) chooseFile(file);
                return;
              }
            }
            if (!composing.current && !e.nativeEvent.isComposing && e.keyCode !== 229 && menuOpen) {
              if (e.key === "Escape") {
                e.preventDefault();
                setInputQuery(undefined);
                return;
              }
              if (matches.length && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
                e.preventDefault();
                setHighlighted(
                  (current) => (current + (e.key === "ArrowDown" ? 1 : -1) + matches.length) % matches.length,
                );
                return;
              }
              if ((e.key === "Enter" && !e.shiftKey) || e.key === "Tab") {
                e.preventDefault();
                const suggestion = matches[highlighted] ?? matches[0];
                if (suggestion) insert(suggestion);
                return;
              }
            }
            if (
              (e.key === "ArrowUp" || e.key === "ArrowDown") &&
              !e.shiftKey &&
              !e.ctrlKey &&
              !e.altKey &&
              !e.metaKey &&
              !composing.current &&
              !e.nativeEvent.isComposing &&
              e.keyCode !== 229 &&
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
            if (
              e.key === "Enter" &&
              !e.shiftKey &&
              !composing.current &&
              !e.nativeEvent.isComposing &&
              e.keyCode !== 229
            ) {
              e.preventDefault();
              void submit();
            }
          }}
        />
        <div className="composer-footer">
          <Menu.Root key={sessionId} modal={false}>
            <Menu.Trigger asChild>
              <button
                type="button"
                className="composer-plus"
                aria-label="添加附件"
                disabled={editing || !context}
                onMouseDown={(e) => e.preventDefault()}
              >
                <Plus size={16} />
              </button>
            </Menu.Trigger>
            <Menu.Portal>
              <Menu.Content
                className="composer-add-menu"
                side="top"
                align="start"
                sideOffset={8}
                onCloseAutoFocus={(event) => event.preventDefault()}
              >
                <Menu.Item
                  onSelect={() => {
                    setFileQuery({
                      start: textarea.current?.selectionStart ?? draft.length,
                      end: textarea.current?.selectionEnd ?? draft.length,
                      query: "",
                      explicit: true,
                    });
                    setInputQuery(undefined);
                    setHighlighted(0);
                  }}
                >
                  <FileCode2 size={16} />
                  插入文件引用
                </Menu.Item>
                <Menu.Item
                  onSelect={() => {
                    setFileQuery(undefined);
                    setInputQuery(undefined);
                    if (context) void addImages(() => context.pickImages(sessionId));
                    textarea.current?.focus();
                  }}
                >
                  <ImagePlus size={16} />
                  添加图片…
                </Menu.Item>
              </Menu.Content>
            </Menu.Portal>
          </Menu.Root>
          <div className="composer-actions">
            {toolbar}
            {busy && !hasDraft ? (
              <button className="send stop" aria-label="停止" title="停止生成" onClick={onStop}>
                <Square size={16} fill="currentColor" />
              </button>
            ) : showSendButton || busy ? (
              <button
                className="send"
                aria-label={busy ? "加入队列" : "发送"}
                title={busy ? "加入队列" : "发送"}
                disabled={
                  submitting ||
                  editing ||
                  value.pending > 0 ||
                  (!draft.trim() && !value.attachments.length && !value.fileReferences.length)
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
    </div>
  );
}
