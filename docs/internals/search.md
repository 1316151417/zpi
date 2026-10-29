# 任务、正文、文件和 Diff 查找

使用入口：[搜索](../features/search.md)。这些入口有不同数据源，不应共用一个模糊的“搜索全部”。

## 任务搜索

任务搜索读取业务与历史索引，结果带任务身份和可定位的历史位置。标题匹配、正文命中和归档状态用于展示及打开行为。打开命中需要按历史水位补页，再定位，不能假设目标已经挂载在 DOM。

检索进度、取消和当前 query 绑定；新 query 到达后丢弃旧结果。任务顺序、分组或标题变化不应让旧对象引用跳到另一个任务。

## 对话内查找

对话查找解析用户能看到的 Markdown 正文，不把推理和全部工具输出默认混进正文结果。Markdown 的语义纯文本提取独立于完整组件渲染，避免为搜索实例化所有图表与 Office 预览。

索引按每批约四个任务、约八毫秒让出主线程；单次 Markdown 解析本身仍不可被中途打断。RunView 使用弱引用缓存；流式运行部分补充实时 DOM 定位，避免等整轮完成才搜得到。

高亮使用 CSS Highlight，普通命中最多约 2000 个并保留活动项。MutationObserver 使过期节点缓存失效；元素缓存使用 WeakMap，shadow DOM 单独处理。关闭查找时清理 highlight 和 observer，不能在任务切换后留下上一个任务的高亮。

## 工作区文件搜索

主进程基于 cwd 扫描，受路径边界、取消和结果数限制，默认最多 1000 个候选。文件树、快速查找和 @ 引用复用名称匹配与目录语义，但可见结果仍各自有 scope。

扫描未完成、达到上限和部分目录不可读分别显示状态。不能把首批未命中当作整个项目没有文件；也不能递归沿符号链接进入无限目录树。

## 审查查找

Review 查找按当前来源读取完整可用文件或 patch，未展开项也可命中。命中身份包含文件与行侧，展开后定位。降级 patch 没有完整未变更内容，搜索范围随实际数据能力变化。

源码：[任务契约](../../packages/desktop/src/shared/task-search.ts)、[任务对话框](../../packages/desktop/src/renderer/TaskSearchDialog.tsx)、[工作区搜索](../../packages/desktop/src/main/workspace-file-searches.ts)、[正文索引](../../packages/ui/src/components/conversation-find.ts)、[Markdown 文本](../../packages/ui/src/components/markdown-find.ts)、[DOM 高亮](../../packages/ui/src/components/find-dom.ts)、[Review 查找](../../packages/ui/src/review-find.ts)。回归：[任务搜索](../../packages/desktop/test/task-search.test.ts)、[文件搜索](../../packages/desktop/test/workspace-file-search.test.ts)、[正文 DOM](../../packages/ui/test/conversation-find-dom.test.ts)、[高亮](../../packages/ui/test/text-find-dom.test.ts)。
