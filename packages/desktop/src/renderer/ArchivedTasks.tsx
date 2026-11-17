import * as Dialog from "@radix-ui/react-dialog";
import { Folder, Search, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { autoArchiveDays, defaultAutoArchiveSettings } from "../shared/auto-archive.ts";
import type { AutoArchiveResult, AutoArchiveSettings, SessionRecord } from "../shared/bridge.ts";
import { deleteSessionWithPanes } from "./pane-store.ts";
import { SettingsHelp } from "./SettingsHelp.tsx";
import { SettingsSelect } from "./SettingsSelect.tsx";
import { refresh, useStore } from "./store.ts";
import { unwrap } from "./unwrap.ts";
import { userErrorMessage } from "./user-error.ts";
import "./auto-archive-settings.css";

type ArchivedRecord = SessionRecord & { projectName: string };
const archiveDayOptions = autoArchiveDays.map((days) => ({
  value: String(days),
  label: `${days} 天后归档`,
}));
export function ArchivedTasks() {
  const sessions = useStore((s) => s.sessions);
  const settings = useStore((s) => s.settings);
  const autoArchive = settings?.autoArchive ?? defaultAutoArchiveSettings;
  const [records, setRecords] = useState<ArchivedRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [deleting, setDeleting] = useState<ArchivedRecord[]>();
  const [archiving, setArchiving] = useState(false);
  const [archiveResult, setArchiveResult] = useState<AutoArchiveResult>();
  const load = useCallback(async () => {
    setRecords(unwrap(await window.zpi.listArchivedSessions()));
  }, []);
  useEffect(() => {
    void load()
      .catch((e) => setError(userErrorMessage(e)))
      .finally(() => setLoading(false));
  }, [load]);
  useEffect(
    () =>
      window.zpi.onTasksChanged?.(() => {
        void load().catch((e) => setError(userErrorMessage(e)));
      }),
    [load],
  );
  const running = (r: ArchivedRecord) => (sessions.get(r.id)?.status ?? r.status) === "running";
  const visible = records.filter((r) =>
    `${r.title} ${r.projectName}`.toLowerCase().includes(query.toLowerCase()),
  );
  const groups = new Map<string, { name: string; records: ArchivedRecord[] }>();
  for (const r of visible) {
    const key = r.diagnostic ? "_damaged" : (r.projectId ?? "_unassigned");
    const group = groups.get(key) ?? { name: r.diagnostic ? "无法读取的任务" : r.projectName, records: [] };
    group.records.push(r);
    groups.set(key, group);
  }
  const remove = async (targets: ArchivedRecord[]) => {
    setBusy(true);
    const failures: string[] = [];
    try {
      for (const r of targets) {
        try {
          await deleteSessionWithPanes(r.id);
        } catch (e) {
          failures.push(`${r.title}：${userErrorMessage(e)}`);
        }
      }
      setDeleting(undefined);
      await load();
      await refresh();
      setError(failures.join("\n"));
    } catch (e) {
      setError(userErrorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const saveAutoArchive = async (input: AutoArchiveSettings) => {
    setBusy(true);
    setError("");
    try {
      const updated = unwrap(await window.zpi.updateAutoArchive(input));
      useStore.setState({ settings: updated });
    } catch (e) {
      setError(userErrorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const archiveNow = async () => {
    setBusy(true);
    setArchiving(true);
    setError("");
    setArchiveResult(undefined);
    try {
      setArchiveResult(unwrap(await window.zpi.runAutoArchive()));
      await load();
      await refresh();
    } catch (e) {
      setError(userErrorMessage(e));
    } finally {
      setArchiving(false);
      setBusy(false);
    }
  };
  return (
    <div className="archived-tasks">
      <div className="settings-page-heading">
        <div className="settings-heading-title">
          <h1>归档管理</h1>
          <SettingsHelp
            label="归档管理"
            text="归档时会一并清理任务的 worktree。存在未提交文件（包括被忽略的文件）、独有提交、打开的终端或仍被其他任务使用时，会跳过归档并保留 worktree。恢复任务时，会在原路径按原分支和提交重建 worktree。"
          />
        </div>
      </div>
      <section className="auto-archive-settings" aria-label="自动归档设置">
        <div className="auto-archive-card">
          <div className="auto-archive-row">
            <span className="auto-archive-copy settings-label">
              <strong>自动归档旧会话</strong>
              <SettingsHelp
                label="自动归档旧会话"
                text="开启后，软件启动并恢复当前任务后会在后台检查一次，运行期间每 5 分钟再次检查。只归档最后活动时间超过保留期的会话；运行中、未读、置顶、当前打开、有草稿或排队输入的任务会跳过。"
              />
            </span>
            <div className="auto-archive-control">
              <label className="settings-switch auto-archive-switch">
                <input
                  type="checkbox"
                  role="switch"
                  aria-label="自动归档旧会话"
                  aria-checked={autoArchive.enabled}
                  checked={autoArchive.enabled}
                  disabled={busy || !settings}
                  onChange={(e) => void saveAutoArchive({ ...autoArchive, enabled: e.currentTarget.checked })}
                />
                <span />
              </label>
            </div>
          </div>
          <div className="auto-archive-row">
            <span className="auto-archive-copy settings-label">
              <strong>归档保留时长</strong>
              <SettingsHelp
                label="归档保留时长"
                text="会话最后更新时间早于该时长后，才会进入自动归档候选。"
              />
            </span>
            <div className="auto-archive-control">
              <SettingsSelect
                label="归档保留时长"
                value={String(autoArchive.olderThanDays)}
                options={archiveDayOptions}
                disabled={busy || !settings}
                onChange={(value) =>
                  void saveAutoArchive({
                    ...autoArchive,
                    olderThanDays: Number(value) as AutoArchiveSettings["olderThanDays"],
                  })
                }
              />
            </div>
          </div>
          <div className="auto-archive-row">
            <span className="auto-archive-copy settings-label">
              <strong>手动归档</strong>
              <SettingsHelp label="手动归档" text="按当前保留时长立即检查历史任务，无需开启自动归档。" />
            </span>
            <div className="auto-archive-control">
              <button
                className="auto-archive-run"
                disabled={busy || !settings}
                onClick={() => void archiveNow()}
              >
                {archiving ? "正在归档…" : "立即归档"}
              </button>
            </div>
          </div>
        </div>
        {archiving && (
          <p className="auto-archive-result" role="status">
            正在检查历史任务并清理 worktree…
          </p>
        )}
        {archiveResult && (
          <div className="auto-archive-result" role="status">
            <p>
              已归档 {archiveResult.archived} 个任务，跳过 {archiveResult.skipped} 个任务。
            </p>
            {archiveResult.details.length > 0 && (
              <ul>
                {archiveResult.details.map((detail) => (
                  <li key={detail.sessionId}>
                    {detail.title}：{detail.reason}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </section>
      <div className="archived-heading">
        <div className="settings-heading-title">
          <h2>已归档任务</h2>
          <SettingsHelp
            label="已归档任务"
            text="可恢复任务，或永久删除任务及其会话记录、图片附件和文件变更快照。删除前会再次确认。"
          />
        </div>
        <button
          className="archived-delete-all"
          disabled={busy || !records.length}
          onClick={() => setDeleting([...records])}
        >
          <Trash2 size={14} />
          全部删除
        </button>
      </div>
      <label className="archived-search">
        <Search size={16} />
        <input
          aria-label="搜索已归档任务"
          placeholder="搜索已归档任务"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </label>
      {error && (
        <div className="run-error" role="alert">
          {error}
        </div>
      )}
      {loading ? (
        <p role="status">正在读取任务…</p>
      ) : !visible.length ? (
        <p className="settings-intro" role="status">
          {query ? "没有匹配的任务" : "暂无已归档任务"}
        </p>
      ) : null}
      {[...groups]
        .sort(([a], [b]) => (a === "_damaged" ? 1 : b === "_damaged" ? -1 : 0))
        .map(([key, group]) => (
          <section className="archived-group" key={key} aria-label={group.name}>
            <header>
              <Folder size={16} />
              <strong>{group.name}</strong>
              <span>{group.records.length} 个任务</span>
            </header>
            <div className="archived-list">
              {group.records.map((r) => (
                <div className="archived-row" key={r.id} data-session-id={r.id}>
                  <div className="archived-copy">
                    <strong title={r.title}>{r.title}</strong>
                    <small>
                      {r.projectName} ·{" "}
                      {r.archivedAt != null
                        ? new Date(r.archivedAt).toLocaleString("zh-CN")
                        : "归档时间不可用"}
                    </small>
                    {r.diagnostic && (
                      <small className="archived-diagnostic" title={r.diagnostic}>
                        {r.diagnostic}
                      </small>
                    )}
                  </div>
                  <button
                    className="archived-delete"
                    aria-label={`删除任务 ${r.title}`}
                    title={running(r) ? "请先停止运行" : "永久删除"}
                    disabled={busy || running(r)}
                    onClick={() => setDeleting([r])}
                  >
                    <Trash2 size={14} />
                  </button>
                  {!r.diagnostic && (
                    <button
                      className="archived-restore"
                      disabled={busy || running(r)}
                      title={running(r) ? "请先停止运行" : undefined}
                      onClick={() => {
                        setBusy(true);
                        setError("");
                        void window.zpi
                          .restoreSession(r.id)
                          .then(unwrap)
                          .then(load)
                          .then(refresh)
                          .catch((e) => setError(userErrorMessage(e)))
                          .finally(() => setBusy(false));
                      }}
                    >
                      恢复
                    </button>
                  )}
                </div>
              ))}
            </div>
          </section>
        ))}
      <Dialog.Root
        open={Boolean(deleting)}
        onOpenChange={(open) => {
          if (!open && !busy) setDeleting(undefined);
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="modal-backdrop archived-delete-backdrop" />
          <Dialog.Content
            className="modal archived-delete-dialog"
            onEscapeKeyDown={(e) => {
              if (busy) e.preventDefault();
            }}
            onPointerDownOutside={(e) => {
              if (busy) e.preventDefault();
            }}
          >
            <Dialog.Title>永久删除 {deleting?.length ?? 0} 个任务？</Dialog.Title>
            <Dialog.Description>
              会话记录、图片附件和文件变更快照将一并删除，无法恢复。项目源文件会保留。
            </Dialog.Description>
            <div className="modal-actions">
              <button className="secondary" disabled={busy} onClick={() => setDeleting(undefined)}>
                取消
              </button>
              <button
                className="danger-button"
                disabled={busy}
                onClick={() => {
                  if (deleting) void remove(deleting);
                }}
              >
                {busy ? "正在删除…" : "确认删除"}
              </button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}
