# 审查渲染复核（2026-10-22）

参照 ZCode `3c5b227649371507ddc4eb46ac5133afe6db1cab` 的 `GitPane`、`GitPaneChangeCard`、`diff-viewer`、`lightweight-diff-preview`、`patchDiffPreview`、`DiffsWorkerPoolProvider` 与 `useGitAutoRefresh`。

上次实现把审查复用到聊天的局部 patch 查看器，缺失完整 before/after，并固定启用 simple separator。普通修改因此没有可展开的未修改行；先前只用新建文件和空态验证，未覆盖这一核心入口。

| 核对项 | 当前实现及验证 |
| --- | --- |
| 普通修改 | 主进程读取 HEAD/index/worktree 或轮次快照，完整两侧使用 MultiFileDiff；缺一侧保留 patch |
| 折叠区 | 120 行 Java、修改第 19/41/63 行，真实 Electron 显示 14/13/13 行折叠条；首部、中间和尾部按钮均补出对应正文 |
| 样式 | unified / bars / word-alt / line-info、12px、同字体栈、GitHub 深浅主题；背景变量直接写入 Shadow DOM host |
| 降级 | 移植参考的纯函数预检：元信息、锁文件、Gradle/zsh、深 hunk、大 patch、800 行上限和截断文案；局部 patch 使用 simple separator |
| 高亮 | 两边实际使用 @pierre/diffs 1.1.22、内部 Shiki 3.23.0；WASM 引擎、最多四个 worker；修复 worker 入口被 tree shaking 删除的问题 |
| 素材 | 本地 1,146 个 Material SVG 与参考逐字节一致；审查使用的 8 个 Lucide icon node 一致 |
| 吸顶遮挡 | 修复展开标题半透明背景导致的代码透出；真实 Electron 深浅主题滚动后，对比代码可见/隐藏时标题截图，像素一致 |
| 状态 | 来源与快照隔离、展开时加载、刷新失效缓存、只展示一个展开文件、虚拟滚动和置顶标题 |
| 刷新 | 沿用 Git 解析的 metadata 目录及非 Linux workspace 递归监听；60 秒防抖，隐藏与卸载清理；有独立生命周期测试 |

执行通过：64 项相关单测、11 个隐藏 Electron 场景、`npm run check`、`npm run build`。check 保留仓库已有的 4 条 warning 与 6 条 info。最后两项核心审查 Electron 场景另行重跑通过。

截图使用 1512 × 893 窗口、隔离 Java fixture，保留折叠/展开及深浅主题结果。视觉验证为截图检查；未执行两套完整客户端的自动像素差分。参考当前上一轮投影尚未接入；ZPI 继续使用已有会话快照，该集成差异沿用审查合同中的明确说明。
