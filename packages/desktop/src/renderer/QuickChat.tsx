import { ArrowUp, CircleAlert, Plus, Square, X } from "lucide-react";
import { type ComponentType, useEffect, useRef, useState } from "react";
import type { Result } from "../shared/bridge.ts";
import type { QuickChatSnapshot } from "../shared/quick-chat.ts";
import type { QuickChatConversationProps } from "./QuickChatConversation.tsx";
import "./quick-chat.css";

// Keep the first input independent of settings/model adapters and rich conversation rendering.
const defaultAppearance = { theme: "system", fontSize: 14 } as const;
const configurationMessage = "默认模型不可用，请到主窗口「设置 → 快速对话」配置。";
const loadConversation = () => import("./QuickChatConversation.tsx");
type ConversationLoader = () => Promise<{ default: ComponentType<QuickChatConversationProps> }>;

function unwrap<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function DeferredConversation({
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
        if (active) setError(errorMessage(reason));
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
}

export function QuickChat({
  conversationLoader = loadConversation,
}: {
  conversationLoader?: ConversationLoader;
}) {
  const [snapshot, setSnapshot] = useState<QuickChatSnapshot>();
  const [snapshotError, setSnapshotError] = useState("");
  const [error, setError] = useState("");
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState<"send" | "stop" | "reset">();
  const [attempt, setAttempt] = useState(0);
  const lock = useRef(false);
  const hiding = useRef(false);
  const composing = useRef(false);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const revision = useRef(-1);
  const currentSession = useRef<string>(undefined);
  const operationGeneration = useRef(0);
  const view = snapshot?.session;
  const expanded = Boolean(view?.runs.length);
  const running = Boolean(view?.runs.some((run) => run.status === "running"));
  const preferences = snapshot?.settings.interface ?? defaultAppearance;
  // The host publishes a validated selection and revalidates every send.
  const selectionValid = Boolean(snapshot?.selection);
  const configurationRequired = Boolean(snapshot && !selectionValid);
  const visibleError = error || snapshotError;

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
      revision.current = next.revision;
      const nextSession = next.session.sessionId;
      if (currentSession.current !== undefined && currentSession.current !== nextSession) {
        operationGeneration.current += 1;
        lock.current = false;
        setPending(undefined);
        setDraft("");
        setError("");
        composing.current = false;
      }
      currentSession.current = nextSession;
      setSnapshot(next);
      setSnapshotError("");
    };
    const off = window.zpiQuickChat.onSnapshot(accept);
    void window.zpiQuickChat
      .getSnapshot()
      .then(unwrap)
      .then(accept)
      .catch((reason) => {
        if (active && revision.current < 0) setSnapshotError(errorMessage(reason));
      });
    return () => {
      active = false;
      off();
    };
  }, [attempt]);

  useEffect(() => {
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
      if (generation === operationGeneration.current) setError(errorMessage(reason));
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
      if (generation === operationGeneration.current) setError(errorMessage(reason));
    } finally {
      if (generation === operationGeneration.current) {
        lock.current = false;
        setPending(undefined);
      }
    }
  }

  const submit = () => {
    if (!draft.trim() || running || !selectionValid || !snapshot) return;
    const submitted = draft;
    void perform(
      "send",
      () => window.zpiQuickChat.send(submitted),
      () => {
        setDraft((current) => (current === submitted ? "" : current));
        textarea.current?.focus();
      },
    );
  };

  return (
    <main
      className={`quick-chat${expanded ? " quick-chat-expanded" : " quick-chat-compact"}`}
      aria-label="快速对话"
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
                    () => textarea.current?.focus(),
                  )
                }
              >
                <Plus size={17} aria-hidden="true" />
              </button>
            </div>
          </header>
          <DeferredConversation
            key={view.sessionId}
            loader={conversationLoader}
            view={view}
            onError={(message) => {
              if (view.sessionId === currentSession.current) setError(message);
            }}
          />
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
          <textarea
            ref={textarea}
            value={draft}
            aria-label="输入消息"
            aria-describedby={configurationRequired ? "quick-chat-configuration" : undefined}
            placeholder={running ? "继续输入，回复结束后发送" : "输入消息…"}
            rows={1}
            disabled={pending === "reset"}
            onChange={(event) => setDraft(event.target.value)}
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
            <div className="quick-chat-error" role="alert" title={visibleError}>
              <CircleAlert className="quick-chat-notice-icon" size={15} aria-hidden="true" />
              <span className="quick-chat-notice-text">{visibleError}</span>
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
            </div>
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
              disabled={Boolean(pending) || !selectionValid || !draft.trim()}
            >
              <ArrowUp size={16} aria-hidden="true" />
            </button>
          )}
        </form>
      </div>
    </main>
  );
}
