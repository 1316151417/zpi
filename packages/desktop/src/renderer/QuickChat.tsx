import { ArrowUp, CircleAlert, Plus, Square, X } from "lucide-react";
import {
  type ComponentType,
  type CSSProperties,
  memo,
  type SetStateAction,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { flushSync } from "react-dom";
import { imageLimits } from "zpi-coding-agent/input";
import type { Result } from "../shared/bridge.ts";
import type { QuickChatSnapshot } from "../shared/quick-chat.ts";
import { QuickChatAttachment } from "./QuickChatAttachment.tsx";
import type { QuickChatConversationProps } from "./QuickChatConversation.tsx";
import { QuickChatError } from "./QuickChatError.tsx";
import { imageImportError, pastedImages, type QuickChatDraftImage } from "./quick-chat-attachments.ts";
import { unwrap } from "./unwrap.ts";
import { userErrorMessage } from "./user-error.ts";
import "./quick-chat.css";

// Keep the first input independent of settings/model adapters and rich conversation rendering.
const defaultAppearance = { theme: "system", fontSize: 14 } as const;
const configurationMessage = "默认模型不可用，请到主窗口「设置 → 快速对话」配置。";
const loadConversation = () => import("./QuickChatConversation.tsx");
const compactComposerMinHeight = 44;
const compactComposerMaxHeight = 184;
const attachmentRowHeight = 56; // 48px thumbnails (with status overlays) and an 8px gap.
const composerVerticalInset = 16; // 7px padding and a 1px border on each edge.
const textareaMinHeight = 24;
const expandedTextareaMaxHeight = 160;
type ConversationLoader = () => Promise<{ default: ComponentType<QuickChatConversationProps> }>;

const DeferredConversation = memo(function DeferredConversation({
  loader,
  ...props
}: QuickChatConversationProps & { loader: ConversationLoader }) {
  const [Content, setContent] = useState<ComponentType<QuickChatConversationProps>>();
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    void loader().then(
      (module) => {
        if (active) setContent(() => module.default);
      },
      (reason) => {
        if (active) setError(userErrorMessage(reason));
      },
    );
    return () => {
      active = false;
    };
  }, [loader, attempt]);
  if (Content) return <Content {...props} />;
  return (
    <div className="quick-chat-conversation-placeholder" role={error ? "alert" : "status"}>
      {error ? (
        <>
          <span>无法加载对话：{error}</span>
          <button
            type="button"
            className="quick-chat-retry"
            onClick={() => {
              setError("");
              setAttempt((value) => value + 1);
            }}
          >
            重试加载对话
          </button>
        </>
      ) : (
        "正在加载对话…"
      )}
    </div>
  );
});

export function QuickChat({
  conversationLoader = loadConversation,
}: {
  conversationLoader?: ConversationLoader;
}) {
  const [snapshot, setSnapshot] = useState<QuickChatSnapshot>();
  const [snapshotError, setSnapshotError] = useState("");
  const [error, updateError] = useState("");
  const [errorVersion, setErrorVersion] = useState(0);
  const [noticeHeight, setNoticeHeight] = useState(0);
  const setError = useCallback((value: SetStateAction<string>) => {
    updateError(value);
    if (typeof value === "string" && value) setErrorVersion((version) => version + 1);
  }, []);
  const [draft, setDraft] = useState("");
  const [images, setImages] = useState<QuickChatDraftImage[]>([]);
  const imagesRef = useRef(images);
  const nextImageKey = useRef(0);
  const draftRevision = useRef(0);
  const lastSubmission = useRef<{
    generation: number;
    revision: number;
    text: string;
    images: QuickChatDraftImage[];
    previousRuns: Set<string>;
    accepted: boolean;
  }>(undefined);
  const mounted = useRef(true);
  const updateImages = useCallback((next: QuickChatDraftImage[]) => {
    imagesRef.current = next;
    setImages(next);
  }, []);
  const [pending, setPending] = useState<"send" | "stop" | "reset">();
  const [attempt, setAttempt] = useState(0);
  const lock = useRef(false);
  const hiding = useRef(false);
  const composing = useRef(false);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const revision = useRef(-1);
  const currentSession = useRef<string>(undefined);
  const currentPresentationVersion = useRef<number>(undefined);
  const visibleErrorRef = useRef("");
  const operationGeneration = useRef(0);
  const reportedHeight = useRef<{ sessionId: string; height: number }>(undefined);
  const presentation = useRef<{ token: number; reported: Set<string> }>(undefined);
  const view = snapshot?.session;
  const expanded = snapshot?.expanded ?? Boolean(view?.runs.length);
  const reservedNoticeHeight = expanded ? 0 : noticeHeight;
  const hasImages = images.length > 0;
  const imagesReady = images.every((item) => item.status === "ready");
  const running = Boolean(view?.runs.some((run) => run.status === "running"));
  const preferences = snapshot?.settings.interface ?? defaultAppearance;
  // The host publishes a validated selection and revalidates every send.
  const selectionValid = Boolean(snapshot?.selection);
  const configurationRequired = Boolean(snapshot && !selectionValid);
  const visibleError = error || snapshotError;
  visibleErrorRef.current = visibleError;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      operationGeneration.current += 1;
      const session = currentSession.current;
      if (session) {
        void window.zpiQuickChat.setNoticeHeight(session, 0).catch(() => {});
        for (const item of imagesRef.current) {
          if (item.image) void window.zpiQuickChat.removeAttachment(session, item.image.id).catch(() => {});
        }
      }
    };
  }, []);

  useEffect(() => {
    document.title = "快速对话 · ZPI";
    document.documentElement.dataset.quickChat = "true";
    return () => {
      delete document.documentElement.dataset.quickChat;
    };
  }, []);

  useEffect(() => {
    let active = true;
    const accept = (next: QuickChatSnapshot) => {
      if (!active || next.revision < revision.current) return;
      const nextSession = next.session.sessionId;
      const nextVersion = next.presentationVersion ?? 0;
      const presentationChanged =
        currentSession.current !== undefined &&
        (currentSession.current !== nextSession || currentPresentationVersion.current !== nextVersion);
      const commit = () => {
        revision.current = next.revision;
        if (currentSession.current !== undefined && currentSession.current !== nextSession) {
          operationGeneration.current += 1;
          lastSubmission.current = undefined;
          lock.current = false;
          setPending(undefined);
          setDraft("");
          updateImages([]);
          setError("");
          composing.current = false;
        }
        currentSession.current = nextSession;
        currentPresentationVersion.current = nextVersion;
        setSnapshot(next);
        setSnapshotError("");
      };
      // IPC events (or the initial request's continuation) are outside React's
      // lifecycle. Commit a discrete new/mode change now, so native presentation
      // does not wait for React's ordinary background update scheduling. Streaming
      // snapshots keep their existing batching and never take this synchronous path.
      if (presentationChanged) flushSync(commit);
      else commit();
    };
    const off = window.zpiQuickChat.onSnapshot(accept);
    void window.zpiQuickChat
      .getSnapshot()
      .then(unwrap)
      .then(accept)
      .catch((reason) => {
        if (active && revision.current < 0) setSnapshotError(userErrorMessage(reason));
      });
    return () => {
      active = false;
      off();
    };
  }, [attempt, updateImages]);

  useEffect(
    () =>
      window.zpiQuickChat.onComposerProbe((token, sessionId) => {
        if (sessionId !== currentSession.current) return;
        // Read live local state, including imports and in-flight actions, without
        // copying draft text or image contents across the presentation boundary.
        const occupied = Boolean(
          textarea.current?.value.length ||
            imagesRef.current.length ||
            lock.current ||
            visibleErrorRef.current,
        );
        void window.zpiQuickChat.reportComposerState(token, sessionId, occupied).catch(() => {});
      }),
    [],
  );

  useEffect(() => {
    const submitted = lastSubmission.current;
    if (!submitted?.accepted || !snapshot || submitted.generation !== operationGeneration.current) return;
    const run = snapshot.session.runs.find((item) => !submitted.previousRuns.has(item.runId));
    if (!run || run.status === "running") return;
    lastSubmission.current = undefined;
    // A provider may fail after IPC accepted the send. Restore only the untouched next draft.
    if (run.status === "error" && submitted.revision === draftRevision.current) {
      setDraft(submitted.text);
      updateImages(submitted.images);
      setError(run.error ? userErrorMessage(run.error) : "发送失败，请重试。");
    }
  }, [snapshot, pending, updateImages]);

  useLayoutEffect(() => {
    const media = matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      document.documentElement.dataset.theme =
        preferences.theme === "system" ? (media.matches ? "dark" : "light") : preferences.theme;
      document.documentElement.style.setProperty("--ui-font-size", `${preferences.fontSize}px`);
    };
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [preferences.theme, preferences.fontSize]);

  const sessionId = view?.sessionId;
  const presentationVersion = snapshot?.presentationVersion ?? 0;
  useLayoutEffect(() => {
    if (sessionId) void window.zpiQuickChat.setNoticeHeight(sessionId, reservedNoticeHeight).catch(() => {});
  }, [sessionId, reservedNoticeHeight]);
  const importImage = useCallback(
    async (item: QuickChatDraftImage) => {
      const importSession = currentSession.current;
      if (!importSession || !imagesRef.current.includes(item)) return;
      const generation = operationGeneration.current;
      const active = () => mounted.current && generation === operationGeneration.current;
      const update = (patch: Partial<QuickChatDraftImage>) => {
        if (!active()) return;
        updateImages(
          imagesRef.current.map((entry) => (entry.key === item.key ? { ...entry, ...patch } : entry)),
        );
      };
      setError((current) => (current === item.error ? "" : current));
      update({ status: "importing", error: undefined });
      try {
        const invalid = imageImportError(item.file);
        if (invalid) throw new Error(invalid);
        const image = unwrap(await window.zpiQuickChat.importAttachment(importSession, item.file));
        if (!active()) {
          void window.zpiQuickChat.removeAttachment(importSession, image.id).catch(() => {});
          return;
        }
        if (!imagesRef.current.some((entry) => entry.key === item.key)) {
          // A paste may finish after the user has already removed its placeholder.
          void window.zpiQuickChat.removeAttachment(importSession, image.id).catch(() => {});
          return;
        }
        update({ image, status: "ready" });
      } catch (reason) {
        if (!active() || !imagesRef.current.some((entry) => entry.key === item.key)) return;
        const message = userErrorMessage(reason);
        update({ status: "failed", error: message });
        setError(message);
      }
    },
    [updateImages],
  );
  useEffect(() => {
    if (!sessionId) return;
    for (const item of imagesRef.current) {
      if (item.status === "queued") void importImage(item);
    }
  }, [sessionId, images, importImage]);

  const removeImage = async (item: QuickChatDraftImage) => {
    if (lock.current || item.status === "removing") return;
    draftRevision.current += 1;
    setError((current) => (current === item.error ? "" : current));
    const removeSession = currentSession.current;
    if (!item.image || !removeSession) {
      updateImages(imagesRef.current.filter((entry) => entry.key !== item.key));
      return;
    }
    const generation = operationGeneration.current;
    updateImages(
      imagesRef.current.map((entry) =>
        entry.key === item.key ? { ...entry, status: "removing", error: undefined } : entry,
      ),
    );
    try {
      unwrap(await window.zpiQuickChat.removeAttachment(removeSession, item.image.id));
      if (mounted.current && generation === operationGeneration.current)
        updateImages(imagesRef.current.filter((entry) => entry.key !== item.key));
    } catch (reason) {
      if (!mounted.current || generation !== operationGeneration.current) return;
      const message = userErrorMessage(reason);
      updateImages(
        imagesRef.current.map((entry) =>
          entry.key === item.key ? { ...entry, status: "ready", error: message } : entry,
        ),
      );
      setError(message);
    }
  };

  const reportConversationError = useCallback(
    (message: string) => {
      if (sessionId === currentSession.current) setError(userErrorMessage(message));
    },
    [sessionId],
  );
  const resizeComposer = useCallback(() => {
    const element = textarea.current;
    if (!element) return;
    // Reset before reading so deletion can shrink as well as typing/pasting can grow.
    // Keep the scrollbar out of the measurement to avoid a width/wrapping feedback loop.
    const scrollTop = element.scrollTop;
    element.style.height = "0px";
    element.style.overflowY = "hidden";
    const contentHeight = Math.max(textareaMinHeight, element.scrollHeight);
    const maxHeight = expanded ? expandedTextareaMaxHeight : compactComposerMaxHeight - composerVerticalInset;
    const height = Math.min(contentHeight, maxHeight);
    element.style.height = `${height}px`;
    // A short display can clamp the native window below the requested height.
    element.style.overflowY = contentHeight > (element.clientHeight || height) ? "auto" : "hidden";
    element.scrollTop = scrollTop;
    if (expanded || !sessionId) return;
    const composerHeight =
      Math.max(compactComposerMinHeight, Math.ceil(height + composerVerticalInset)) +
      (hasImages ? attachmentRowHeight : 0);
    const previous = reportedHeight.current;
    if (previous?.sessionId === sessionId && previous.height === composerHeight) return;
    const request = { sessionId, height: composerHeight };
    reportedHeight.current = request;
    const retryLater = () => {
      if (reportedHeight.current === request) reportedHeight.current = undefined;
    };
    void window.zpiQuickChat.setComposerHeight(sessionId, composerHeight).then((result) => {
      if (!result.ok) retryLater();
    }, retryLater);
  }, [expanded, sessionId, hasImages]);

  useLayoutEffect(() => {
    resizeComposer();
  }, [resizeComposer, draft, preferences.fontSize, configurationRequired, visibleError]);

  useEffect(() => {
    const element = textarea.current;
    if (!element) return;
    let active = true;
    let frame: number | undefined;
    const schedule = () => {
      if (!active || frame !== undefined) return;
      frame = requestAnimationFrame(() => {
        frame = undefined;
        resizeComposer();
      });
    };
    // Height changes are ours; only width changes require another layout measurement.
    let width = element.getBoundingClientRect().width;
    const observer = new ResizeObserver((entries) => {
      const nextWidth = entries[0]?.contentRect.width;
      if (nextWidth === undefined || nextWidth === width) return;
      width = nextWidth;
      schedule();
    });
    observer.observe(element);
    window.addEventListener("resize", schedule);
    window.addEventListener("focus", schedule);
    const fonts = document.fonts;
    void fonts?.ready.then(schedule);
    fonts?.addEventListener("loadingdone", schedule);
    return () => {
      active = false;
      observer.disconnect();
      if (frame !== undefined) cancelAnimationFrame(frame);
      window.removeEventListener("resize", schedule);
      window.removeEventListener("focus", schedule);
      fonts?.removeEventListener("loadingdone", schedule);
    };
  }, [resizeComposer]);

  useLayoutEffect(() => {
    if (!sessionId) return;
    void window.zpiQuickChat.rendererCommitted(sessionId, presentationVersion).catch(() => {});
    // A task queued inside rAF runs after that rendering opportunity, without
    // waiting for a second vsync. A microtask/Promise would run before rendering.
    // Like the former double-rAF barrier, this is not compositor-pixel proof.
    let task: ReturnType<typeof setTimeout> | undefined;
    const frame = requestAnimationFrame(() => {
      task = setTimeout(() => {
        void window.zpiQuickChat.rendererReady(sessionId, presentationVersion).catch(() => {});
      }, 0);
    });
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(task);
    };
  }, [sessionId, presentationVersion, expanded]);

  const reportPresentation = useCallback((stage: "renderer-ready" | "renderer-focus" | "renderer-frame") => {
    const current = presentation.current;
    if (!current || current.reported.has(stage)) return;
    current.reported.add(stage);
    void window.zpiQuickChat.reportPresentation(current.token, stage).catch(() => {});
  }, []);

  useEffect(() => {
    let first: number | undefined;
    let second: number | undefined;
    const cancelFrames = () => {
      if (first !== undefined) cancelAnimationFrame(first);
      if (second !== undefined) cancelAnimationFrame(second);
      first = undefined;
      second = undefined;
    };
    const off = window.zpiQuickChat.onPresentation((token) => {
      if (presentation.current?.token === token) return;
      cancelFrames();
      presentation.current = { token, reported: new Set() };
      if (textarea.current && !textarea.current.disabled) reportPresentation("renderer-ready");
      if (document.activeElement === textarea.current) reportPresentation("renderer-focus");
      first = requestAnimationFrame(() => {
        first = undefined;
        second = requestAnimationFrame(() => {
          second = undefined;
          reportPresentation("renderer-frame");
        });
      });
    });
    return () => {
      off();
      cancelFrames();
      presentation.current = undefined;
    };
  }, [reportPresentation]);

  useLayoutEffect(() => {
    if (textarea.current && !textarea.current.disabled) reportPresentation("renderer-ready");
  }, [reportPresentation, pending]);

  useEffect(() => {
    const frame = requestAnimationFrame(() => textarea.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [view?.sessionId]);

  useEffect(() => {
    const focus = () => {
      if (!document.querySelector('[role="menu"]')) textarea.current?.focus();
    };
    const keydown = (event: KeyboardEvent) => {
      if (
        event.key !== "Escape" ||
        event.defaultPrevented ||
        event.repeat ||
        event.isComposing ||
        event.keyCode === 229 ||
        composing.current ||
        document.querySelector('[role="menu"], dialog[open], [role="dialog"]')
      )
        return;
      event.preventDefault();
      void hide();
    };
    window.addEventListener("focus", focus);
    window.addEventListener("keydown", keydown);
    return () => {
      window.removeEventListener("focus", focus);
      window.removeEventListener("keydown", keydown);
    };
  }, []);

  async function hide() {
    if (hiding.current) return;
    hiding.current = true;
    const generation = operationGeneration.current;
    try {
      unwrap(await window.zpiQuickChat.hide());
    } catch (reason) {
      if (generation === operationGeneration.current) setError(userErrorMessage(reason));
    } finally {
      hiding.current = false;
    }
  }

  async function perform(
    action: NonNullable<typeof pending>,
    operation: () => Promise<Result<void>>,
    complete?: () => void,
  ) {
    if (lock.current) return;
    lock.current = true;
    const generation = operationGeneration.current;
    setPending(action);
    setError("");
    try {
      unwrap(await operation());
      if (generation === operationGeneration.current) complete?.();
    } catch (reason) {
      if (generation === operationGeneration.current) {
        if (action === "send") lastSubmission.current = undefined;
        setError(userErrorMessage(reason));
      }
    } finally {
      if (generation === operationGeneration.current) {
        lock.current = false;
        setPending(undefined);
      }
    }
  }

  const submit = () => {
    if (
      lock.current ||
      (!draft.trim() && !hasImages) ||
      !imagesReady ||
      running ||
      !selectionValid ||
      !snapshot
    )
      return;
    const submitted = draft;
    const submittedImages = imagesRef.current;
    const submission = {
      generation: operationGeneration.current,
      revision: draftRevision.current,
      text: submitted,
      images: submittedImages,
      previousRuns: new Set(snapshot.session.runs.map((run) => run.runId)),
      accepted: false,
    };
    lastSubmission.current = submission;
    const attachmentIds = submittedImages.flatMap((item) => (item.image ? [item.image.id] : []));
    void perform(
      "send",
      () =>
        attachmentIds.length
          ? window.zpiQuickChat.send(submitted, attachmentIds)
          : window.zpiQuickChat.send(submitted),
      () => {
        submission.accepted = true;
        setDraft((current) => (current === submitted ? "" : current));
        const sent = new Set(submittedImages.map((item) => item.key));
        updateImages(imagesRef.current.filter((item) => !sent.has(item.key)));
        textarea.current?.focus();
      },
    );
  };

  return (
    <main
      className={`quick-chat${expanded ? " quick-chat-expanded" : " quick-chat-compact"}${hasImages ? " quick-chat-has-images" : ""}${visibleError ? " quick-chat-has-error" : ""}`}
      aria-label="快速对话"
      style={{ "--quick-chat-notice-height": `${reservedNoticeHeight}px` } as CSSProperties}
      data-testid="quick-chat"
      data-state={expanded ? "expanded" : "compact"}
    >
      {expanded && view && (
        <>
          <header className="quick-chat-header">
            <div className="quick-chat-window-actions">
              <button
                type="button"
                className="quick-chat-icon-button"
                aria-label="新对话"
                title="新对话"
                disabled={Boolean(pending)}
                onClick={() =>
                  void perform(
                    "reset",
                    () => window.zpiQuickChat.reset(),
                    () => {
                      lastSubmission.current = undefined;
                      setDraft("");
                      updateImages([]);
                      textarea.current?.focus();
                    },
                  )
                }
              >
                <Plus size={17} aria-hidden="true" />
              </button>
            </div>
          </header>
          {view.runs.length ? (
            <DeferredConversation
              key={view.sessionId}
              loader={conversationLoader}
              view={view}
              cwd={snapshot.cwd}
              onError={reportConversationError}
            />
          ) : (
            <div className="quick-chat-empty-conversation" />
          )}
        </>
      )}

      <div className="quick-chat-composer-container">
        <form
          className="composer quick-chat-composer"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          {hasImages && (
            <fieldset className="quick-chat-attachments" aria-label="待发送图片">
              {images.map((item) => (
                <QuickChatAttachment
                  key={`${sessionId}:${item.key}`}
                  sessionId={sessionId}
                  item={item}
                  disabled={Boolean(pending)}
                  onRemove={() => void removeImage(item)}
                  onRetry={() => void importImage(item)}
                />
              ))}
            </fieldset>
          )}
          <div className="quick-chat-composer-input-row">
            <textarea
              ref={textarea}
              value={draft}
              aria-label="输入消息"
              aria-describedby={configurationRequired ? "quick-chat-configuration" : undefined}
              placeholder={running ? "继续输入，回复结束后发送" : "输入消息…"}
              rows={1}
              disabled={pending === "reset"}
              onChange={(event) => {
                draftRevision.current += 1;
                setDraft(event.target.value);
              }}
              onPaste={(event) => {
                const files = pastedImages(event.clipboardData);
                if (!files.length) return;
                event.preventDefault();
                if (pending === "reset") return;
                draftRevision.current += 1;
                const available = imageLimits.count - imagesRef.current.length;
                if (files.length > available) setError(`每条消息最多可添加 ${imageLimits.count} 张图片。`);
                const added = files.slice(0, available).map(
                  (file): QuickChatDraftImage => ({
                    key: ++nextImageKey.current,
                    file,
                    status: "queued",
                  }),
                );
                updateImages([...imagesRef.current, ...added]);
                const text = event.clipboardData.getData("text/plain");
                if (!text) return;
                const element = event.currentTarget;
                const start = element.selectionStart;
                const end = element.selectionEnd;
                const generation = operationGeneration.current;
                setDraft((current) => current.slice(0, start) + text + current.slice(end));
                requestAnimationFrame(() => {
                  if (generation === operationGeneration.current && textarea.current === element)
                    element.setSelectionRange(start + text.length, start + text.length);
                });
              }}
              onFocus={() => reportPresentation("renderer-focus")}
              onCompositionStart={() => {
                composing.current = true;
              }}
              onCompositionEnd={() => {
                composing.current = false;
              }}
              onKeyDown={(event) => {
                if (
                  event.key !== "Enter" ||
                  event.shiftKey ||
                  event.ctrlKey ||
                  event.metaKey ||
                  event.altKey ||
                  event.nativeEvent.isComposing ||
                  event.keyCode === 229 ||
                  composing.current
                )
                  return;
                event.preventDefault();
                if (!event.repeat) submit();
              }}
            />
            {visibleError && (
              <QuickChatError
                message={visibleError}
                occurrence={errorVersion}
                reservedHeight={reservedNoticeHeight}
                onHeightChange={setNoticeHeight}
              >
                {!snapshot ? (
                  <button
                    type="button"
                    className="quick-chat-retry"
                    onClick={() => {
                      setError("");
                      setSnapshotError("");
                      setAttempt((value) => value + 1);
                    }}
                  >
                    重新加载
                  </button>
                ) : (
                  <button type="button" aria-label="关闭提示" onClick={() => setError("")}>
                    <X size={14} aria-hidden="true" />
                  </button>
                )}
              </QuickChatError>
            )}
            {configurationRequired && (
              <div
                className="quick-chat-configuration"
                id="quick-chat-configuration"
                role="status"
                title={configurationMessage}
              >
                <CircleAlert className="quick-chat-notice-icon" size={15} aria-hidden="true" />
                <span className="quick-chat-notice-text">{configurationMessage}</span>
              </div>
            )}
            {running ? (
              <button
                type="button"
                className="send stop"
                aria-label="停止"
                title="停止生成"
                disabled={Boolean(pending)}
                onClick={() => void perform("stop", () => window.zpiQuickChat.stop())}
              >
                <Square size={16} fill="currentColor" aria-hidden="true" />
              </button>
            ) : (
              <button
                type="submit"
                className="send"
                aria-label="发送"
                title={!snapshot ? "正在连接…" : configurationRequired ? configurationMessage : "发送"}
                disabled={
                  Boolean(pending) || !selectionValid || !imagesReady || (!draft.trim() && !hasImages)
                }
              >
                <ArrowUp size={16} aria-hidden="true" />
              </button>
            )}
          </div>
        </form>
      </div>
    </main>
  );
}
