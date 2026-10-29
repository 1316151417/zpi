# Git 审查、工具快照与文件回退

使用入口：[变更审查](../features/review.md)。

## 来源决定语义

Git 审查有 unstaged、staged、branch 来源；last-turn 读取当前任务最新 run 的工具文件快照。非 Git 目录仍可查看 last-turn。branch 使用上游与 HEAD 的三点比较，没有上游返回空，不猜一个远端分支。

Git 调用有超时和输出边界，禁用 external diff/textconv，路径采用 literal 处理，范围限制在所选工作目录子树。未暂存列表合并 tracked、untracked 和 conflicts。未跟踪空文件、二进制、超过 1 MiB 或不可读文件按规则省略；tracked 二进制保留降级说明。

## 两种 Diff 模型

可获得完整 before/after 的文件交给 MultiFileDiff，默认统一视图，可展开未修改区域。语法高亮和 diff 计算由 worker pool 承担，支持主题、行号、换行和逐词变化选项。

只有 patch、快照缺失或内容过大时退回轻量 patch 展示，最多 800 行。降级视图不能声称已加载完整文件。文件列表虚拟化，初始折叠，按需展开并缓存；来源改变或刷新后清除不再有效的内容。

## 更新与查找

监听工作区与 Git dir/common dir，合并短时间内变化；非 Linux 路径可使用递归监听。隐藏标签释放监听和请求；重新显示、聚焦或显式刷新按当前来源重取。

查找在当前审查来源上按需读取，命中不依赖文件已展开。任务/来源/文件身份共同决定缓存，迟到请求不能把旧分支内容覆盖进新视图。

## 工具文件变更

write/edit 的观察器在 mutation queue 内保存 before/after、hash 和 operation，模型的结果文字与文件事实分开。写入后快照记录失败仍要说明“文件已修改但记录不可用”，不能返回没有副作用的假象。

同轮相同路径聚合为首个 before 到最后 after 的净变化；改回原样不累计中间行数。单次工具卡片只显示自身 patch，任务轮末摘要显示聚合结果。输出不足时标记不完整，不伪造零变化。

## 回退事务

回退计划先校验当前文件与期望 after hash，遇到外部更改交由冲突流程。实际回退包含创建、修改、删除的对应反向操作。历史提交与文件回退需要协调；如果后续步骤失败，尝试恢复本次已回退文件。

恢复只覆盖仍处于本次回退状态的路径；另一写者已再次改变的文件保留并报告，不能以回滚之名覆盖新内容。这是带校验的文件操作，不是全盘快照或 Git reset。

源码：[Git](../../packages/desktop/src/main/git-review.ts)、[文件事实](../../packages/coding-agent/src/core/tools/file-change.ts)、[聚合](../../packages/desktop/src/main/file-changes.ts)、[回退](../../packages/desktop/src/main/file-rewind.ts)、[ReviewPane](../../packages/desktop/src/renderer/ReviewPane.tsx)、[富 Diff](../../packages/ui/src/components/ReviewDiffViewer.tsx)。回归：[Git](../../packages/desktop/test/git-review.test.ts)、[回退](../../packages/desktop/test/file-rewind.test.ts)、[Diff](../../packages/ui/test/review-diff.test.ts)、[界面](../../packages/desktop/test/review-pane-dom.test.ts)。
