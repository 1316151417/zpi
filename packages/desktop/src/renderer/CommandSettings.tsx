import * as Dialog from "@radix-ui/react-dialog";
import * as Menu from "@radix-ui/react-dropdown-menu";
import {
  Check,
  ChevronDown,
  ChevronRight,
  Folder,
  LoaderCircle,
  Monitor,
  MoreHorizontal,
  Plus,
  RefreshCcw,
  Search,
  SquareArrowRightEnter,
  Terminal,
  Trash2,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ActionHint } from "zpi-ui";
import type { CustomCommand, CustomCommandInput } from "../shared/custom-commands.ts";
import { CommandImportDialog } from "./CommandImportDialog.tsx";
import { useStore } from "./store.ts";
import { unwrap } from "./unwrap.ts";
import { userErrorMessage } from "./user-error.ts";
import "./command-settings.css";

export function CommandSettings({
  breadcrumbContainer,
  onEditingChange,
}: {
  breadcrumbContainer: HTMLElement | null;
  onEditingChange: (editing: boolean) => void;
}) {
  const projects = useStore((state) => state.projects);
  const [projectId, setProjectId] = useState<string>();
  const [linkedSave, setLinkedSave] = useState<CustomCommandInput>();
  const [commands, setCommands] = useState<CustomCommand[]>([]);
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [editor, setEditor] = useState<CustomCommand | "new">();
  useEffect(() => {
    onEditingChange(Boolean(editor));
    return () => onEditingChange(false);
  }, [editor, onEditingChange]);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [importing, setImporting] = useState(false);
  const request = useRef(0);
  const mounted = useRef(true);
  const operationPending = useRef(false);
  const moreButton = useRef<HTMLButtonElement>(null);
  const confirmationFocus = useRef<HTMLElement | null>(null);
  const rememberConfirmationFocus = () => {
    confirmationFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  };
  const restoreConfirmationFocus = (event: Event) => {
    event.preventDefault();
    const previous = confirmationFocus.current;
    (previous?.isConnected ? previous : moreButton.current)?.focus();
  };
  const refresh = useCallback(
    async (showLoading = true) => {
      if (showLoading) setLoading(true);
      const token = ++request.current;
      try {
        const result = unwrap(await window.zpi.getCustomCommands(projectId));
        if (!mounted.current || request.current !== token) return;
        setCommands(result.commands);
        setError(result.diagnostics.map((item) => userErrorMessage(item.message)).join("\n"));
      } catch (failure) {
        if (mounted.current && request.current === token) setError(userErrorMessage(failure));
      } finally {
        if (mounted.current && request.current === token) setLoading(false);
      }
    },
    [projectId],
  );
  useEffect(() => {
    mounted.current = true;
    setCommands([]);
    setError("");
    void refresh();
    const focus = () => void refresh(false);
    window.addEventListener("focus", focus);
    return () => {
      mounted.current = false;
      request.current++;
      window.removeEventListener("focus", focus);
    };
  }, [refresh]);
  useEffect(() => {
    if (projectId && !projects.some((project) => project.id === projectId)) {
      setProjectId(undefined);
      setEditor(undefined);
      setLinkedSave(undefined);
      setImporting(false);
    }
  }, [projectId, projects]);
  const act = async (operation: () => Promise<unknown>, close = false) => {
    if (operationPending.current) return;
    operationPending.current = true;
    setBusy(true);
    setError("");
    try {
      await operation();
      if (!mounted.current) return;
      if (close) {
        setEditor(undefined);
        setConfirmDelete(false);
      }
      await refresh();
      window.dispatchEvent(new Event("zpi:commands-changed"));
    } catch (failure) {
      if (mounted.current) setError(userErrorMessage(failure));
    } finally {
      operationPending.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  const save = (config: CustomCommandInput, confirmed = false) => {
    if (editor && editor !== "new" && editor.importedSourcePath && !confirmed) {
      rememberConfirmationFocus();
      setLinkedSave(config);
      return Promise.resolve();
    }
    return act(async () => {
      if (!editor) return;
      unwrap(
        editor === "new"
          ? await window.zpi.createCustomCommand(config, projectId)
          : await window.zpi.updateCustomCommand(
              {
                ...config,
                id: editor.id,
                expectedRevision: editor.revision,
                ...(editor.importedSourcePath
                  ? { confirmLinkedSource: true, expectedSourcePath: editor.importedSourcePath }
                  : {}),
              },
              projectId,
            ),
      );
      setLinkedSave(undefined);
    }, true);
  };
  const scopeControl = (
    <CommandScope
      projectId={projectId}
      align={editor ? "end" : "start"}
      disabled={busy || Boolean(editor && editor !== "new")}
      onChange={setProjectId}
    />
  );
  const filtered = commands.filter((command) =>
    `${command.name} ${command.description ?? ""} ${command.prompt}`
      .toLowerCase()
      .includes(query.trim().toLowerCase()),
  );
  return (
    <section
      className="command-settings"
      aria-label="命令设置"
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing || event.keyCode === 229) return;
        if (event.key === "Escape" && editor && !event.defaultPrevented) {
          event.stopPropagation();
          if (!busy && !confirmDelete && !linkedSave) {
            setEditor(undefined);
            setError("");
          }
        }
      }}
    >
      {editor ? (
        <>
          {breadcrumbContainer &&
            createPortal(
              <nav className="command-breadcrumb" aria-label="命令导航">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    setEditor(undefined);
                    setError("");
                  }}
                >
                  命令
                </button>
                <ChevronRight size={14} />
                <span aria-current="page">{editor === "new" ? "新建命令" : editor.name}</span>
              </nav>,
              breadcrumbContainer,
            )}
          <h3>{editor === "new" ? "新建命令" : "编辑命令"}</h3>
          <p className="command-editor-description">
            {editor === "new" ? "填写命令名称和提示词，保存后返回列表。" : "修改命令内容，保存后返回列表。"}
          </p>
          {error && (
            <p className="run-error" role="alert">
              {error}
            </p>
          )}
          <CommandEditor
            key={editor === "new" ? "new" : editor.id}
            initial={editor === "new" ? undefined : editor}
            busy={busy}
            scopeControl={scopeControl}
            onCancel={() => {
              setEditor(undefined);
              setError("");
            }}
            onDelete={() => {
              setError("");
              rememberConfirmationFocus();
              setConfirmDelete(true);
            }}
            onSave={save}
          />
        </>
      ) : (
        <>
          <div className="command-settings-toolbar">
            <div className="command-scope-count">
              {scopeControl}
              <i />
              <strong>
                命令 <small>{filtered.length}</small>
              </strong>
            </div>
            <label className="command-search">
              <Search size={16} />
              <input
                aria-label="搜索命令"
                placeholder="搜索命令..."
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </label>
          </div>
          {error && (
            <p className="run-error" role="alert">
              {error}
            </p>
          )}
          <div className="command-installed-header">
            <h3>
              已安装 <small>{filtered.length}</small>
            </h3>
            <div className="command-header-actions">
              <Menu.Root>
                <Menu.Trigger
                  ref={moreButton}
                  className="resource-icon-button"
                  aria-label="更多操作"
                  disabled={busy}
                >
                  <MoreHorizontal size={16} />
                </Menu.Trigger>
                <Menu.Portal>
                  <Menu.Content
                    className="selection-menu command-menu"
                    align="end"
                    sideOffset={2}
                    onEscapeKeyDown={(event) => event.stopPropagation()}
                  >
                    <Menu.Item className="menu-item" onSelect={() => setImporting(true)}>
                      <SquareArrowRightEnter size={16} />
                      导入
                    </Menu.Item>
                  </Menu.Content>
                </Menu.Portal>
              </Menu.Root>
              <ActionHint appearance="control" label="刷新">
                <button
                  type="button"
                  className="resource-icon-button"
                  aria-label="刷新命令"
                  aria-busy={loading}
                  disabled={busy || loading}
                  onClick={() => void refresh()}
                >
                  {loading ? (
                    <LoaderCircle size={16} className="command-loading-spinner" />
                  ) : (
                    <RefreshCcw size={16} />
                  )}
                </button>
              </ActionHint>
              <button
                type="button"
                className="command-new"
                disabled={busy}
                onClick={() => {
                  setEditor("new");
                  setError("");
                }}
              >
                <Plus size={14} />
                新建
              </button>
            </div>
          </div>
          {loading ? (
            <div className="command-loading" role="status">
              <LoaderCircle size={16} className="command-loading-spinner" />
              加载中...
            </div>
          ) : filtered.length ? (
            <div className="command-list">
              {filtered.map((command) => (
                <div className="command-row" key={command.id}>
                  <button
                    type="button"
                    className="command-edit"
                    disabled={busy}
                    onClick={() => {
                      setEditor(command);
                      setError("");
                    }}
                    aria-label={`编辑命令 ${command.name}`}
                  >
                    <span className="command-avatar">
                      <Terminal size={16} />
                    </span>
                    <span className="command-summary">
                      <span className="command-name" title={command.name}>
                        {command.name}
                        {command.argumentHint && <span>{command.argumentHint}</span>}
                      </span>
                      <small>{command.description || "暂无描述"}</small>
                    </span>
                  </button>
                  <label className="settings-switch">
                    <input
                      type="checkbox"
                      aria-label={`启用命令 ${command.name}`}
                      checked={command.enabled}
                      disabled={busy || command.unreadable}
                      onChange={(event) => {
                        const enabled = event.target.checked;
                        void act(async () =>
                          unwrap(
                            await window.zpi.setCustomCommandEnabled({ id: command.id, enabled }, projectId),
                          ),
                        );
                      }}
                    />
                    <span aria-hidden="true" />
                  </label>
                </div>
              ))}
            </div>
          ) : (
            <div className="command-empty">
              {query.trim() ? (
                "没有匹配的命令"
              ) : (
                <>
                  <h3>尚未安装命令</h3>
                  <p>新建命令，或从外部 Agent 导入已有命令。</p>
                  <button type="button" className="command-new" onClick={() => setEditor("new")}>
                    <Plus size={16} />
                    新建
                  </button>
                </>
              )}
            </div>
          )}
        </>
      )}
      {importing && (
        <CommandImportDialog
          projectId={projectId}
          onClose={() => {
            setImporting(false);
            moreButton.current?.focus();
          }}
          onImported={async () => {
            await refresh();
            window.dispatchEvent(new Event("zpi:commands-changed"));
          }}
        />
      )}
      <Dialog.Root
        open={confirmDelete}
        onOpenChange={(open) => {
          if (!busy) setConfirmDelete(open);
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="modal-backdrop command-confirm-backdrop" />
          <Dialog.Content
            className="command-delete-dialog"
            onCloseAutoFocus={restoreConfirmationFocus}
            onPointerDownOutside={(event) => {
              if (busy) event.preventDefault();
            }}
            onEscapeKeyDown={(event) => {
              event.stopPropagation();
              if (busy) event.preventDefault();
            }}
          >
            <Dialog.Title>删除命令</Dialog.Title>
            <Dialog.Description>
              确定要删除命令「{editor && editor !== "new" ? editor.name : ""}」吗？此操作无法撤销。
              {editor && editor !== "new" && editor.importedSourcePath
                ? "仅删除此链接，不会删除源命令文件。"
                : ""}
            </Dialog.Description>
            {error && (
              <p className="run-error" role="alert">
                {error}
              </p>
            )}
            <div className="command-form-actions">
              <Dialog.Close disabled={busy}>取消</Dialog.Close>
              <button
                type="button"
                className="command-confirm-delete"
                disabled={busy}
                onClick={() => {
                  if (editor && editor !== "new")
                    void act(
                      async () =>
                        unwrap(
                          await window.zpi.deleteCustomCommand(
                            { id: editor.id, expectedRevision: editor.revision },
                            projectId,
                          ),
                        ),
                      true,
                    );
                }}
              >
                删除
              </button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
      <Dialog.Root
        open={Boolean(linkedSave)}
        onOpenChange={(open) => {
          if (!open && !busy) setLinkedSave(undefined);
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="modal-backdrop command-confirm-backdrop" />
          <Dialog.Content
            className="command-delete-dialog"
            onCloseAutoFocus={restoreConfirmationFocus}
            onPointerDownOutside={(event) => {
              if (busy) event.preventDefault();
            }}
            onEscapeKeyDown={(event) => {
              event.stopPropagation();
              if (busy) event.preventDefault();
            }}
          >
            <Dialog.Title>修改源命令文件</Dialog.Title>
            <Dialog.Description>
              保存将修改链接指向的源命令文件：
              <br />
              {editor && editor !== "new" ? editor.importedSourcePath : ""}
            </Dialog.Description>
            {error && (
              <p className="run-error" role="alert">
                {error}
              </p>
            )}
            <div className="command-form-actions">
              <Dialog.Close disabled={busy}>取消</Dialog.Close>
              <button
                type="button"
                className="command-new"
                disabled={busy}
                onClick={() => {
                  if (linkedSave) void save(linkedSave, true);
                }}
              >
                确认保存
              </button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </section>
  );
}
export function CommandEditor({
  initial,
  busy,
  scopeControl,
  onSave,
  onCancel,
  onDelete,
}: {
  scopeControl: import("react").ReactNode;
  initial?: CustomCommand;
  busy: boolean;
  onSave: (config: CustomCommandInput) => Promise<void>;
  onCancel: () => void;
  onDelete: () => void;
}) {
  const [name, setName] = useState(initial?.name.replace(/^\//, "") ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [argumentHint, setArgumentHint] = useState(initial?.argumentHint ?? "");
  const [prompt, setPrompt] = useState(initial?.prompt ?? "");
  const composing = useRef(false);
  const valid = Boolean(
    !initial?.unreadable && prompt.trim() && (initial || /^[A-Za-z0-9_-]{1,50}$/.test(name.trim())),
  );
  return (
    <form
      className="command-form"
      onCompositionStart={() => {
        composing.current = true;
      }}
      onCompositionEnd={() => {
        composing.current = false;
      }}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing || event.keyCode === 229) return;
        if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
          event.preventDefault();
          if (valid && !busy) event.currentTarget.requestSubmit();
        }
      }}
      onSubmit={(event) => {
        event.preventDefault();
        if (valid && !busy && !composing.current)
          void onSave({
            name: name.trim(),
            description: description.trim() || undefined,
            argumentHint: argumentHint.trim() || undefined,
            prompt: prompt.trim(),
          });
      }}
    >
      {initial?.unreadable && (
        <p className="run-error" role="alert">
          源命令无法读取。可删除此链接，或修复源文件后刷新。
        </p>
      )}
      <div className="command-form-top">
        <label>
          名称
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="my-command"
            disabled={Boolean(initial) || busy}
            maxLength={50}
          />
        </label>
        <span>作用域 {scopeControl}</span>
      </div>
      <label>
        描述（可选）
        <input
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          placeholder="在命令选择器中显示的简短描述"
          disabled={busy}
        />
      </label>
      <label>
        参数提示（可选）
        <input
          value={argumentHint}
          onChange={(event) => setArgumentHint(event.target.value)}
          placeholder="例如 <file-path>"
          disabled={busy}
        />
      </label>
      <label>
        提示词
        <textarea
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          rows={5}
          placeholder="填写调用该命令时发送的提示词..."
          disabled={busy}
        />
      </label>
      <div className="command-form-actions">
        {initial && (
          <button type="button" className="command-delete" disabled={busy} onClick={onDelete}>
            <Trash2 size={14} />
            删除
          </button>
        )}
        <button className="command-new" type="submit" disabled={!valid || busy}>
          {busy ? "保存中..." : "保存"}
        </button>
        <button className="secondary" type="button" disabled={busy} onClick={onCancel}>
          取消
        </button>
      </div>
    </form>
  );
}

function CommandScope({
  align,
  projectId,
  disabled,
  onChange,
}: {
  align: "start" | "end";
  projectId?: string;
  disabled?: boolean;
  onChange: (id?: string) => void;
}) {
  const projects = useStore((state) => state.projects);
  const project = projects.find((item) => item.id === projectId);
  return (
    <Menu.Root>
      <Menu.Trigger className="command-scope" disabled={disabled} aria-label="命令范围">
        {project ? <Folder size={16} /> : <Monitor size={16} />}
        <span title={project?.name ?? "用户"}>{project?.name ?? "用户"}</span>
        <ChevronDown size={16} />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Content
          className="selection-menu command-menu command-scope-menu"
          align={align}
          sideOffset={2}
          onEscapeKeyDown={(event) => event.stopPropagation()}
        >
          <Menu.RadioGroup value={projectId ?? ""} onValueChange={(value) => onChange(value || undefined)}>
            <Menu.RadioItem className="menu-item" value="">
              <Monitor size={16} />
              <span>用户</span>
              <Menu.ItemIndicator>
                <Check size={14} />
              </Menu.ItemIndicator>
            </Menu.RadioItem>
            {projects.some((item) => !item.hidden) && (
              <>
                <Menu.Separator className="command-menu-separator" />
                <Menu.Label className="menu-label">项目</Menu.Label>
              </>
            )}
            {projects
              .filter((item) => !item.hidden)
              .map((item) => (
                <Menu.RadioItem className="menu-item" key={item.id} value={item.id}>
                  <Folder size={16} />
                  <span title={item.name}>{item.name}</span>
                  <Menu.ItemIndicator>
                    <Check size={14} />
                  </Menu.ItemIndicator>
                </Menu.RadioItem>
              ))}
          </Menu.RadioGroup>
        </Menu.Content>
      </Menu.Portal>
    </Menu.Root>
  );
}
