import * as Menu from "@radix-ui/react-dropdown-menu";
import { Check, ChevronRight, GitBranch, Search, Settings, Shuffle } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { GitEnvironment, SessionRecord } from "../shared/bridge.ts";
import { report, unwrap, useStore } from "./store.ts";

export function WorktreeSettings({ record }: { record: SessionRecord }) {
  const [environment, setEnvironment] = useState<GitEnvironment | null>(null);
  const [saving, setSaving] = useState(false);
  const [open, setOpen] = useState(false);
  const [branchesOpen, setBranchesOpen] = useState(false);
  const [query, setQuery] = useState("");
  const menu = useRef<HTMLDivElement>(null);
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
      })
      .catch(report)
      .finally(() => setSaving(false));
  };
  return (
    <div className="draft-environment">
      <Menu.Root
        open={open}
        onOpenChange={(value) => {
          setOpen(value);
          if (!value) {
            setBranchesOpen(false);
            setQuery("");
          }
        }}
      >
        <Menu.Trigger className="environment-trigger" aria-label="配置本地环境">
          <Settings size={17} />
        </Menu.Trigger>
        <Menu.Portal>
          <Menu.Content
            ref={menu}
            className="draft-project-menu environment-menu"
            side="top"
            align="end"
            sideOffset={4}
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
                      sideOffset={4}
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
