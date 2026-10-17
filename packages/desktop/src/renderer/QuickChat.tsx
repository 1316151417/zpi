import { Plus, Square, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { ActionHint, Conversation } from "zpi-ui";
import type { Result } from "../shared/bridge.ts";
import { defaultPreferences } from "../shared/config.ts";
import type { QuickChatSnapshot } from "../shared/quick-chat.ts";
import { quickChatSelectionIsValid } from "../shared/quick-chat-settings.ts";
import "./quick-chat.css";

function unwrap<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function QuickChat() {
  const [snapshot, setSnapshot] = useState<QuickChatSnapshot>();
  const [error, setError] = useState("");
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState<"send" | "stop" | "reset">();
  const [attempt, setAttempt] = useState(0);
  const lock = useRef(false);
  const hiding = useRef(false);
  const composing = useRef(false);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const revision = useRef(-1);
  const view = snapshot?.session;
  const expanded = Boolean(view?.runs.length);
  const running = Boolean(view?.runs.some((run) => run.status === "running"));
  const preferences = snapshot?.settings.interface ?? defaultPreferences;
  const selection = snapshot?.selection;
  const selectionValid = Boolean(
    snapshot && selection && quickChatSelectionIsValid(snapshot.settings.providers, selection),
  );
  const configurationRequired = Boolean(snapshot && !selectionValid);

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
      setSnapshot(next);
    };
    const off = window.zpiQuickChat.onSnapshot(accept);
    void window.zpiQuickChat
      .getSnapshot()
      .then(unwrap)
      .then(accept)
      .catch((reason) => {
        if (active) setError(errorMessage(reason));
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
    if (!view) return;
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
    try {
      unwrap(await window.zpiQuickChat.hide());
    } catch (reason) {
      setError(errorMessage(reason));
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
    setPending(action);
    setError("");
    try {
      unwrap(await operation());
      complete?.();
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      lock.current = false;
      setPending(undefined);
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
              <ActionHint label="新对话" appearance="control" side="bottom">
                <button
                  type="button"
                  className="quick-chat-icon-button"
                  aria-label="新对话"
                  disabled={Boolean(pending)}
                  onClick={() =>
                    void perform(
                      "reset",
                      () => window.zpiQuickChat.reset(),
                      () => {
                        setDraft("");
                        textarea.current?.focus();
                      },
                    )
                  }
                >
                  <Plus size={17} aria-hidden="true" />
                </button>
              </ActionHint>
              <ActionHint label="隐藏" shortcut="Esc" appearance="control" side="bottom">
                <button
                  type="button"
                  className="quick-chat-icon-button"
                  aria-label="隐藏"
                  onClick={() => void hide()}
                >
                  <X size={17} aria-hidden="true" />
                </button>
              </ActionHint>
            </div>
          </header>
          <Conversation
            key={view.sessionId}
            view={view}
            persistReading={false}
            onCopy={(text) => window.zpiQuickChat.copyText(text).then(unwrap)}
            onLink={(url) => {
              void window.zpiQuickChat
                .openExternal(url)
                .then(unwrap)
                .catch((reason) => setError(errorMessage(reason)));
            }}
            onFile={() => setError("快速对话不支持预览本地文件")}
          />
        </>
      )}

      <div className="quick-chat-composer-container">
        <form
          className={`composer quick-chat-composer${running ? " quick-chat-composer-running" : ""}`}
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
            placeholder={!snapshot ? "正在加载…" : running ? "继续输入，回复结束后发送" : "输入消息…"}
            rows={1}
            disabled={!snapshot || pending === "reset"}
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
          {error && (
            <div className="quick-chat-error" role="alert">
              <span>{error}</span>
              {!snapshot ? (
                <button
                  type="button"
                  className="quick-chat-retry"
                  onClick={() => {
                    setError("");
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
            <p className="quick-chat-configuration" id="quick-chat-configuration" role="status">
              默认模型不可用，请到主窗口「设置 → 快速对话」配置。
            </p>
          )}
          {running && (
            <ActionHint label="停止生成" appearance="control">
              <button
                type="button"
                className="quick-chat-stop"
                aria-label="停止"
                disabled={Boolean(pending)}
                onClick={() => void perform("stop", () => window.zpiQuickChat.stop())}
              >
                <Square size={12} fill="currentColor" aria-hidden="true" />
              </button>
            </ActionHint>
          )}
        </form>
      </div>
    </main>
  );
}
