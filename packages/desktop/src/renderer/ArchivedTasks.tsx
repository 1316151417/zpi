import * as Dialog from "@radix-ui/react-dialog";
import { Folder, Search, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { SessionRecord } from "../shared/bridge.ts";
import { refresh, unwrap, useStore } from "./store.ts";

type ArchivedRecord = SessionRecord & { projectName: string };
export function ArchivedTasks() {
  const sessions = useStore((s) => s.sessions);
  const [records, setRecords] = useState<ArchivedRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [deleting, setDeleting] = useState<ArchivedRecord[]>();
  const load = useCallback(async () => {
    setRecords(unwrap(await window.ZPI.listArchivedSessions()));
  }, []);
  useEffect(() => {
    void load()
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, [load]);
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
          unwrap(await window.ZPI.deleteSession(r.id));
        } catch (e) {
          failures.push(`${r.title}：${e instanceof Error ? e.message : String(e)}`);
        }
      }
      setDeleting(undefined);
      await load();
      await refresh();
      setError(failures.join("\n"));
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="archived-tasks">
      <div className="archived-heading">
        <h1>已归档任务</h1>
        <button
          className="archived-delete-all"
          disabled={busy || !records.length}
          onClick={() => setDeleting([...records])}
        >
          <Trash2 size={14} />
          全部删除
        </button>
      </div>
      <p className="settings-intro">恢复任务，或永久删除任务及其会话记录、图片附件和文件变更快照。</p>
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
                        void window.ZPI.restoreSession(r.id)
                          .then(unwrap)
                          .then(load)
                          .then(refresh)
                          .catch((e) => setError(String(e)))
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
              <button disabled={busy} onClick={() => setDeleting(undefined)}>
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
