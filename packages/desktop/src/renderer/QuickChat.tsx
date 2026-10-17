import * as Menu from "@radix-ui/react-dropdown-menu";
import { ArrowUp, Check, ChevronDown, MessageCircle, Plus, Square, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { ActionHint, Conversation } from "zpi-ui";
import type { CombinedSelection, Result } from "../shared/bridge.ts";
import { availablePresets, defaultPreferences, defaultPreset } from "../shared/config.ts";
import type { QuickChatSnapshot } from "../shared/quick-chat.ts";
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
  const [pending, setPending] = useState<"send" | "stop" | "reset" | "selection">();
  const [modelOpen, setModelOpen] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const lock = useRef(false);
  const hiding = useRef(false);
  const composing = useRef(false);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const revision = useRef(-1);
  const view = snapshot?.session;
  const running = Boolean(view?.runs.some((run) => run.status === "running"));
  const preferences = snapshot?.settings.interface ?? defaultPreferences;
  const providers = snapshot?.settings.providers.filter(
    (provider) => provider.enabled !== false && provider.models.some((model) => model.enabled !== false),
  );
  const selection = snapshot?.selection;
  const provider = providers?.find((item) => item.id === selection?.provider);
  const model = provider?.models.find((item) => item.id === selection?.modelId && item.enabled !== false);
  const selectionValid = Boolean(selection && model && availablePresets(model).includes(selection.reasoning));

  useEffect(() => {
    document.title = "快速对话 · ZPI";
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

  const select = (next: CombinedSelection) => {
    void perform(
      "selection",
      () => window.zpiQuickChat.setSelection(next),
      () => {
        setModelOpen(false);
        textarea.current?.focus();
      },
    );
  };

  return (
    <main className="quick-chat" aria-label="快速对话" data-testid="quick-chat">
      <header className="quick-chat-header">
        <span className="quick-chat-title">快速对话</span>
        <div className="quick-chat-window-actions">
          <ActionHint label="新对话" appearance="control" side="bottom">
            <button
              type="button"
              className="quick-chat-icon-button"
              aria-label="新对话"
              disabled={!snapshot || Boolean(pending)}
              onClick={() =>
                void perform(
                  "reset",
                  () => window.zpiQuickChat.reset(),
                  () => {
                    setDraft("");
                    setModelOpen(false);
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

      {!view ? (
        <div className="quick-chat-empty" role="status">
          {error ? (
            <button
              type="button"
              onClick={() => {
                setError("");
                setAttempt((value) => value + 1);
              }}
            >
              重新加载
            </button>
          ) : (
            "正在加载…"
          )}
        </div>
      ) : view.runs.length ? (
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
      ) : (
        <div className="quick-chat-empty">
          <MessageCircle size={26} strokeWidth={1.25} aria-hidden="true" />
          <p>有什么想聊的？</p>
          <span>临时对话，不保存到任务列表</span>
        </div>
      )}

      <div className="quick-chat-composer-container">
        {error && (
          <div className="quick-chat-error" role="alert">
            <span>{error}</span>
            <button type="button" aria-label="关闭提示" onClick={() => setError("")}>
              <X size={14} aria-hidden="true" />
            </button>
          </div>
        )}
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
            placeholder={running ? "继续输入，回复结束后发送" : "输入消息…"}
            rows={3}
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
          <div className="composer-footer">
            <Menu.Root open={modelOpen} onOpenChange={setModelOpen}>
              <Menu.Trigger
                type="button"
                className="model-trigger"
                aria-label="模型选择"
                disabled={!snapshot || running || Boolean(pending)}
                title={running ? "回复结束后可切换模型" : undefined}
              >
                <span className="model-label">{selectionValid ? model?.name || model?.id : "选择模型"}</span>
                <ChevronDown size={14} aria-hidden="true" />
              </Menu.Trigger>
              <Menu.Portal>
                <Menu.Content
                  className="selection-menu quick-chat-model-menu"
                  side="top"
                  align="start"
                  sideOffset={8}
                  collisionPadding={12}
                  loop
                  onCloseAutoFocus={(event) => {
                    event.preventDefault();
                    textarea.current?.focus();
                  }}
                >
                  {providers?.map((item) => (
                    <Menu.Group key={item.id}>
                      <Menu.Label className="menu-label">{item.name}</Menu.Label>
                      {item.models
                        .filter((configured) => configured.enabled !== false)
                        .map((configured) => (
                          <Menu.Item
                            key={configured.id}
                            className="menu-item"
                            disabled={Boolean(pending)}
                            onSelect={(event) => {
                              event.preventDefault();
                              select({
                                provider: item.id,
                                modelId: configured.id,
                                reasoning:
                                  selection?.provider === item.id &&
                                  selection.modelId === configured.id &&
                                  availablePresets(configured).includes(selection.reasoning)
                                    ? selection.reasoning
                                    : defaultPreset(configured),
                              });
                            }}
                          >
                            <span>{configured.name || configured.id}</span>
                            {selection?.provider === item.id && selection.modelId === configured.id && (
                              <Check size={14} aria-hidden="true" />
                            )}
                          </Menu.Item>
                        ))}
                    </Menu.Group>
                  ))}
                  {!providers?.length && <p className="quick-chat-model-empty">请先在主窗口设置中配置模型</p>}
                </Menu.Content>
              </Menu.Portal>
            </Menu.Root>
            {running ? (
              <ActionHint label="停止生成" appearance="control">
                <button
                  type="button"
                  className="send stop"
                  aria-label="停止"
                  disabled={Boolean(pending)}
                  onClick={() => void perform("stop", () => window.zpiQuickChat.stop())}
                >
                  <Square size={14} fill="currentColor" aria-hidden="true" />
                </button>
              </ActionHint>
            ) : (
              <ActionHint label="发送" shortcut="Enter" appearance="control">
                <button
                  type="submit"
                  className="send"
                  aria-label="发送"
                  disabled={!draft.trim() || !selectionValid || Boolean(pending)}
                >
                  <ArrowUp size={17} aria-hidden="true" />
                </button>
              </ActionHint>
            )}
          </div>
        </form>
        <p className="quick-chat-hint">
          {snapshot && !providers?.length ? "请先在主窗口设置中配置模型" : "Shift + Enter 换行 · Esc 隐藏"}
        </p>
      </div>
    </main>
  );
}
