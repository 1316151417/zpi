import { ChevronRight, TriangleAlert } from "lucide-react";
import { useEffect, useState } from "react";
import type { FileActionHandler, FileChangeSummary, RunView } from "../types.ts";
import type { ComposerContext } from "./InputContext.tsx";
import { OpenFileButton } from "./OpenFileButton.tsx";
import { FileIcon } from "./Reference.tsx";

export function ChangedFiles({
  run,
  sessionId,
  readFileChanges,
  cwd,
  onChanges,
  onFile,
  onFileAction,
}: {
  run: RunView;
  sessionId?: string;
  readFileChanges?: ComposerContext["readFileChanges"];
  cwd?: string;
  onChanges?: (runId: string, path?: string) => void;
  onFile?: (path: string) => void;
  onFileAction?: FileActionHandler;
}) {
  const [error, setError] = useState("");
  const key = JSON.stringify([sessionId, run.runId, run.status, run.endedAt]);
  const hasChanges = run.orderedBlocks.some((block) => block.type === "tool" && block.fileChange);
  const [loaded, setLoaded] = useState<{ key: string; changes: FileChangeSummary[] }>();
  useEffect(() => {
    if (!sessionId || !readFileChanges || run.status === "running" || !hasChanges) return;
    let active = true;
    void readFileChanges(sessionId, run.runId).then(
      (changes) => {
        if (active) setLoaded({ key, changes });
      },
      () => {
        // Keep the recorded paths visible with unknown counts when snapshots cannot be loaded.
      },
    );
    return () => {
      active = false;
    };
  }, [sessionId, run.runId, run.status, hasChanges, key, readFileChanges]);
  if (run.status === "running") return null;
  const netChanges = loaded?.key === key ? loaded.changes : undefined;
  const awaitingNetChanges = Boolean(sessionId && readFileChanges && !netChanges);
  const changes =
    netChanges ??
    run.orderedBlocks.flatMap((block) =>
      block.type === "tool" && block.fileChange ? [block.fileChange] : [],
    );
  const files = new Map<
    string,
    { additions: number; deletions: number; known: boolean; failed: boolean; edits: number }
  >();
  for (const change of changes) {
    const file = files.get(change.path) ?? {
      additions: 0,
      deletions: 0,
      known: true,
      failed: false,
      edits: 0,
    };
    file.additions += change.additions ?? 0;
    file.deletions += change.deletions ?? 0;
    file.known &&= !awaitingNetChanges && change.additions !== undefined && change.deletions !== undefined;
    file.failed ||= Boolean(change.failed);
    file.edits++;
    // Multiple legacy operation patches cannot establish the whole turn's net diff.
    if (file.edits > 1) file.known = false;
    files.set(change.path, file);
  }
  if (!files.size) return null;
  const summaries = Array.from(files.values());
  const known = summaries.every((file) => file.known);
  const additions = summaries.reduce((sum, file) => sum + file.additions, 0);
  const deletions = summaries.reduce((sum, file) => sum + file.deletions, 0);
  const root = cwd ? `${cwd.replace(/\/$/, "")}/` : undefined;
  return (
    <details className="changed-files">
      <summary className="changed-files-summary">
        <ChevronRight size={14} aria-hidden="true" className="changed-files-chevron" />
        <span className="changed-files-heading">
          <strong>{files.size} 个文件已更改</strong>
          {summaries.some((file) => file.failed) && (
            <span className="changed-files-warning" role="img" aria-label="部分修改失败" title="部分修改失败">
              <TriangleAlert size={14} aria-hidden="true" />
            </span>
          )}
        </span>
        <span className="changed-files-totals" title="本轮修改前后对比的净变化行数">
          {known ? (
            <>
              <span className="diff-added">+{additions}</span>
              <span className="diff-removed">-{deletions}</span>
            </>
          ) : (
            <span className="changed-file-note">行数未完整统计</span>
          )}
        </span>
      </summary>
      <ul className="changed-files-list">
        {Array.from(files, ([path, file]) => {
          const displayPath = root && path.startsWith(root) ? path.slice(root.length) : path;
          const name = displayPath.split("/").at(-1) ?? displayPath;
          const directory = displayPath.slice(0, -name.length);
          const review = () => onChanges?.(run.runId, path);
          return (
            <li className="changed-file-row" key={path} title={path}>
              <button
                type="button"
                className="changed-file-card"
                onClick={review}
                disabled={!onChanges}
                aria-label={`查看修改 ${name}`}
              >
                <span className="changed-file-info">
                  <FileIcon path={path} size={16} />
                  <strong>{name}</strong>
                  {directory && <span className="changed-file-directory">{directory}</span>}
                </span>
                <span className="changed-file-counts">
                  {file.known ? (
                    <>
                      {file.additions > 0 && <span className="diff-added">+{file.additions}</span>}
                      {file.deletions > 0 && <span className="diff-removed">-{file.deletions}</span>}
                    </>
                  ) : (
                    <span className="changed-file-note">无法统计行数</span>
                  )}
                  {file.failed && <span className="changed-file-note">部分修改失败</span>}
                </span>
              </button>
              <span className="changed-file-actions">
                <button
                  type="button"
                  className="changed-file-review"
                  aria-label={`审查 ${name}`}
                  title="审查"
                  disabled={!onChanges}
                  onClick={review}
                >
                  审查
                </button>
                <OpenFileButton
                  path={path}
                  name={name}
                  onOpen={onFile}
                  onAction={onFileAction}
                  onError={setError}
                />
              </span>
            </li>
          );
        })}
      </ul>
      {error && (
        <p className="changed-files-error" role="alert">
          {error}
        </p>
      )}
    </details>
  );
}
