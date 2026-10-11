import * as Menu from "@radix-ui/react-dropdown-menu";
import { GitBranch, Settings, Shuffle } from "lucide-react";
import { useEffect, useState } from "react";
import type { SessionRecord } from "../shared/bridge.ts";
import { report, unwrap, useStore } from "./store.ts";

export function WorktreeSettings({ record }: { record: SessionRecord }) {
  const [environment, setEnvironment] = useState<{ branch: string; head: string } | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    let active = true;
    void window.ZPI.getGitEnvironment(record.id)
      .then(unwrap)
      .then((value) => {
        if (active) setEnvironment(value);
      })
      .catch(report);
    return () => {
      active = false;
    };
  }, [record.id]);
  if (!environment || record.parentSessionId) return null;
  return (
    <div className="draft-environment">
      <Menu.Root>
        <Menu.Trigger className="environment-trigger" aria-label="配置本地环境">
          <Settings size={17} />
        </Menu.Trigger>
        <Menu.Portal>
          <Menu.Content className="draft-project-menu environment-menu" side="top" align="end" sideOffset={4}>
            <Menu.Label className="environment-label">配置本地环境</Menu.Label>
            <div className="draft-project-options">
              <Menu.CheckboxItem
                className="draft-project-option"
                checked={record.newWorktree ?? false}
                disabled={saving || Boolean(record.worktree)}
                onSelect={(event) => event.preventDefault()}
                onCheckedChange={(enabled) => {
                  setSaving(true);
                  void window.ZPI.setNewWorktree(record.id, enabled)
                    .then(unwrap)
                    .then((updated) => {
                      const sessions = new Map(useStore.getState().sessions);
                      sessions.set(updated.id, updated);
                      useStore.setState({ sessions });
                    })
                    .catch(report)
                    .finally(() => setSaving(false));
                }}
              >
                <Shuffle size={16} />
                <span>新工作树</span>
                <span
                  className="environment-switch"
                  data-checked={record.newWorktree ?? false}
                  aria-hidden="true"
                />
              </Menu.CheckboxItem>
              <div className="draft-project-option environment-branch">
                <GitBranch size={16} />
                <span>分支</span>
                <small>{environment.branch}</small>
              </div>
            </div>
          </Menu.Content>
        </Menu.Portal>
      </Menu.Root>
    </div>
  );
}
