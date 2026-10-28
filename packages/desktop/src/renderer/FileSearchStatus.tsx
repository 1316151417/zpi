import type { WorkspaceFileSearchResult } from "../shared/workspace-files.ts";

export function FileSearchStatus({
  result,
  loading,
  onContinue,
  error,
}: {
  result?: WorkspaceFileSearchResult;
  loading: boolean;
  onContinue: () => void;
  error?: string;
}) {
  if (!error && (!result || (!result?.continuation && !result?.truncated && !result?.incomplete)))
    return null;
  return (
    <div role="status" className="file-tree-notice">
      {result?.continuation && <span>部分目录尚未搜索。</span>}
      {result?.truncated && <span>已显示最佳 {result?.entries.length} 个匹配，请缩小搜索范围。</span>}
      {result?.incomplete && <span>部分路径无法读取，结果可能不完整。</span>}
      {(error || result?.continuation) && (
        <button type="button" disabled={loading} onClick={onContinue}>
          {loading ? "正在搜索…" : error ? "重新搜索" : "继续搜索"}
        </button>
      )}
    </div>
  );
}
