import * as Menu from "@radix-ui/react-dropdown-menu";
import { Check, ChevronRight, GitBranch, Search, Settings, Shuffle } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { ActionHint } from "zpi-ui";
import type { GitEnvironment, SessionRecord } from "../shared/bridge.ts";
import { formatShortcut } from "../shared/shortcuts.ts";
import { focusComposer, report, useStore } from "./store.ts";
import { unwrap } from "./unwrap.ts";

import { useOverlayShortcut } from "./use-overlay-shortcut.ts";

export function WorktreeSettings({
  record,
  open,
  onOpenChange,
}: {
  record: SessionRecord;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const shortcuts = useStore((state) => state.settings?.shortcuts);
  const [environment, setEnvironment] = useState<GitEnvironment | null>(null);
  const [saving, setSaving] = useState(false);
  const [branchesOpen, setBranchesOpen] = useState(false);
  const [query, setQuery] = useState("");
  const menu = useRef<HTMLDivElement>(null);
  const available = Boolean(environment);
  useOverlayShortcut("configure-environment", open && available, () => {
    setBranchesOpen(false);
    setQuery("");
    onOpenChange(false);
  });
  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() =>
      menu.current
        ?.querySelector<HTMLElement>('[role="menuitemcheckbox"]:not([aria-disabled="true"])')
        ?.focus(),
    );
    return () => cancelAnimationFrame(frame);
  }, [open, available]);
  useEffect(() => {
    let active = true;
    void window.zpi
      .getGitEnvironment(record.id)
      .then(unwrap)
      .then((value) => {
        if (active) setEnvironment(value);
      })
      .catch(report);
    return () => {
      active = false;
    };
  }, [record.id, open]);
  if (!environment || record.parentSessionId) return null;
  const baseRef = record.worktreeBaseRef ?? environment.currentRef ?? "HEAD";
  const baseName =
    baseRef === "HEAD"
      ? `当前提交 · ${environment.head.slice(0, 7)}`
      : baseRef.replace(/^refs\/(heads|remotes)\//, "");
  const branches = environment.branches.filter((branch) =>
    branch.name.toLowerCase().includes(query.trim().toLowerCase()),
  );
  const save = (enabled: boolean, ref = baseRef) => {
    setSaving(true);
    void window.zpi
      .setNewWorktree(record.id, enabled, ref)
      .then(unwrap)
      .then((updated) => {
        const sessions = new Map(useStore.getState().sessions);
        sessions.set(updated.id, updated);
        useStore.setState({ sessions });
        setBranchesOpen(false);
        setQuery("");
        if (branchesOpen) {
          requestAnimationFrame(() =>
            menu.current?.querySelector<HTMLElement>('[aria-haspopup="menu"]')?.focus(),
          );
        }
      })
      .catch(report)
      .finally(() => setSaving(false));
  };
  return (
    <div className="draft-environment">
      <Menu.Root
        open={open}
        onOpenChange={(value) => {
          onOpenChange(value);
          if (!value) {
            setBranchesOpen(false);
            setQuery("");
          }
        }}
      >
        <ActionHint
          label="配置本地环境"
          appearance="control"
          shortcut={
            shortcuts?.enabled && shortcuts.bindings["configure-environment"]
              ? formatShortcut(shortcuts.bindings["configure-environment"], window.zpi.platform)
              : undefined
          }
          open={open ? false : undefined}
        >
          <Menu.Trigger className="environment-trigger" aria-label="配置本地环境">
            <Settings size={17} />
          </Menu.Trigger>
        </ActionHint>
        <Menu.Portal>
          <Menu.Content
            ref={menu}
            className="draft-project-menu environment-menu"
            data-shortcut-owner="configure-environment"
            side="top"
            align="end"
            sideOffset={4}
            loop
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              focusComposer(record.id);
            }}
          >
            <Menu.Label className="environment-label">配置本地环境</Menu.Label>
            <div className="draft-project-options">
              <Menu.CheckboxItem
                className="draft-project-option"
                checked={record.newWorktree ?? false}
                disabled={saving || Boolean(record.worktree)}
                onSelect={(event) => event.preventDefault()}
                onCheckedChange={(enabled) => save(enabled)}
              >
                <Shuffle size={16} />
                <span>新工作树</span>
                <span
                  className="environment-switch"
                  data-checked={record.newWorktree ?? false}
                  aria-hidden="true"
                />
              </Menu.CheckboxItem>
              {record.newWorktree ? (
                <Menu.Sub
                  open={branchesOpen}
                  onOpenChange={(value) => {
                    setBranchesOpen(value);
                    if (!value) setQuery("");
                  }}
                >
                  <Menu.SubTrigger
                    className="draft-project-option environment-branch"
                    disabled={saving || Boolean(record.worktree)}
                    title={baseName}
                  >
                    <GitBranch size={16} />
                    <span>起始分支</span>
                    <small>{baseName}</small>
                    <ChevronRight size={14} />
                  </Menu.SubTrigger>
                  <Menu.Portal>
                    <Menu.SubContent
                      className="draft-project-menu environment-menu worktree-branch-menu"
                      data-shortcut-owner="configure-environment"
                      sideOffset={4}
                      loop
                      onFocusOutside={(event) => {
                        if (event.target === menu.current) event.preventDefault();
                      }}
                    >
                      <div className="draft-project-search">
                        <Search size={16} />
                        <input
                          aria-label="搜索起始分支"
                          placeholder="搜索分支"
                          value={query}
                          onChange={(event) => setQuery(event.target.value)}
                          onKeyDown={(event) => {
                            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                              event.preventDefault();
                              const items = event.currentTarget
                                .closest('[role="menu"]')
                                ?.querySelectorAll<HTMLElement>(
                                  '[role="menuitem"]:not([aria-disabled="true"])',
                                );
                              (event.key === "ArrowDown" ? items?.[0] : items?.[items.length - 1])?.focus();
                            }
                            if (event.key !== "Escape" && event.key !== "Tab") event.stopPropagation();
                          }}
                        />
                      </div>
                      <div className="draft-project-options">
                        {(!environment.currentRef || baseRef === "HEAD") && !query && (
                          <Menu.Item
                            className="draft-project-option"
                            disabled={saving}
                            onSelect={(event) => {
                              event.preventDefault();
                              save(true, "HEAD");
                            }}
                          >
                            <span>当前提交 · {environment.head.slice(0, 7)}</span>
                            {baseRef === "HEAD" && <Check size={16} />}
                          </Menu.Item>
                        )}
                        {[false, true].map((remote) => {
                          const group = branches.filter((branch) => branch.remote === remote);
                          if (!group.length) return null;
                          return (
                            <Menu.Group key={String(remote)}>
                              <Menu.Label className="environment-label">
                                {remote ? "远程分支（本地已同步）" : "本地分支"}
                              </Menu.Label>
                              {group.map((branch) => (
                                <Menu.Item
                                  key={branch.ref}
                                  className="draft-project-option"
                                  title={branch.name}
                                  disabled={saving}
                                  onSelect={(event) => {
                                    event.preventDefault();
                                    save(true, branch.ref);
                                  }}
                                >
                                  <span>{branch.name}</span>
                                  {branch.ref === baseRef && <Check size={16} />}
                                </Menu.Item>
                              ))}
                            </Menu.Group>
                          );
                        })}
                        {!branches.length && query && <p className="draft-project-empty">没有匹配的分支</p>}
                      </div>
                    </Menu.SubContent>
                  </Menu.Portal>
                </Menu.Sub>
              ) : (
                <div className="draft-project-option environment-branch">
                  <GitBranch size={16} />
                  <span>分支</span>
                  <small>{environment.branch}</small>
                </div>
              )}
            </div>
          </Menu.Content>
        </Menu.Portal>
      </Menu.Root>
    </div>
  );
}
