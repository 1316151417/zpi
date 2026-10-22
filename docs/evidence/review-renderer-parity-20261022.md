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

## 第二次源码复核

用户要求再次逐项核对后，发现 0.2.170 仍有下列遗漏，已在工作区修正：

| 项目 | ZCode 依据 | 修正与验证 |
| --- | --- | --- |
| 来源往返 | GitPane.handleSelectSource | 切换后清除展开文件，不能返回旧来源时复活；DOM 与 Electron 回归覆盖 |
| 列表顺序 | useGitRepository.SECTION_ORDER_BY_SOURCE / buildSectionsForSource | 已跟踪、未跟踪、冲突分别排序后排列；真实合并冲突 fixture 验证 |
| 冲突来源 | gitService.toChangeForSource | 冲突只出现在未暂存，显示 +0/-0，不能混进已暂存 |
| 未跟踪过滤 | gitService.shouldIncludeUntrackedChange / gitCliHelpers.countUntrackedFileLines | 排除空文件、二进制、超过 1 MiB、不可读文件；stat 跟随有效符号链接，与参考一致 |
| 文件标题和菜单 | fileDisplay.buildFilePath / GitPane 中文标签 / Select | 父路径保留尾斜杠、通用文件管理器文案、14px 来源箭头、22px 菜单滚动区、聚焦/悬停边框 |
| 代码偏好 | codePreviewSettings / codePreviewPreferences / DiffViewer / LightweightDiffPreview | 十种主题、12–20px 字号、行号和换行持久化；富 Diff 消费字号和主题，轻量 Diff 另消费行号/换行，与参考实际组件一致；worker 同步主题变化 |
| 查找顺序和计数 | GitPane/helpers.getGitPaneDiffFindContent | 完整快照按 before、after 顺序计数，未修改内容两侧各一次；按真实行坐标定位，重复文本不能全部跳到同一行；局部 patch 仍剥离协议头 |

再次实测 160 个文件名/扩展名映射，均与参考 resolveIconName 相同；1,146 个 Material SVG 再次逐字节比对相同。参考中的 Git 来源、空态文案、渲染路径阈值、800 行降级边界、worker 参数、虚拟列表和菜单动作已重新检查。

本轮验证覆盖 69 项相关单测、10 个不同的隐藏 Electron 场景，以及 check/build。Electron 不仅检查设置保存，还验证 18px 字号、Vitesse 深浅主题的真实代码颜色、偏好重载、两侧查找计数/高亮和吸顶标题遮挡。

范围说明：这是本地审查面板及其代码预览偏好的对照。ZPI 继续使用自身 Electron IPC、设置存储和上一轮快照；参考的上一轮投影当前仍是空壳。吸顶标题继续采用不透明底色，避免复现代码透出的问题。尚未执行两套完整客户端的自动逐像素比较，不能据此声称整个客户端已无任何像素差异。

## 第三次复核（2026-10-23）

补齐审查所在的公共侧栏外壳：标签搜索总览、最近关闭八个标签、关闭当前／其他／全部、完整视图、完整对话标签和浮动编辑器。复用既有任务、输入框和会话实例，补上按任务的完整视图状态、七处拖动吸附、最小化恢复、新回答预览和 Cmd/Ctrl+Shift+F。快捷键通过既有分发及偏好迁移，保留旧的自定义、清空和冲突设置。继续复核素材时，将浮动把手改为参考的 GripVertical，移除空闲态额外状态文案，并对齐菜单图标、宽度和弹出方向。

重新发现并修正悬停时全局 button 样式覆盖审查标题背景的问题；明暗主题都检查悬停和非悬停的吸顶标题。来源菜单聚焦阴影也按参考清除，限定于审查控件。

新增可选的 `review-reference.spec.ts`，在同一隔离 Electron 中分别构建实际 ZCode 与 ZPI 的审查组件，注入相同的 120 行 Java 快照、三个修改点和固定视口；没有把参考截图当作手写模拟页面。统计原始 PNG，允许每通道不超过 2 的背景舍入差异，同时单独统计标题以下的代码区域：

| 状态 | 全图有差异像素 | 任意通道差值大于 2 | 代码区域有差异像素 |
| --- | ---: | ---: | ---: |
| 浅色折叠 | 670 | 0 | 0 |
| 浅色来源菜单 | 277 | 0 | 0 |
| 浅色展开并滚动 | 42,750 | 40,601 | 0 |
| 深色折叠 | 20,612 | 0 | 0 |

展开状态的差异集中在吸顶标题：参考会模糊透出下方代码，ZPI 保留不透明背景，修复用户指出的文字重叠。该测试证明这些受控组件状态的对照结果，不代表整个客户端、所有文件或窗口尺寸都逐像素相同。

本轮通过 158 项相关单测、12 个后台 Electron 场景、1 个独立参考组件对照场景，以及 check/build；check 仍为原有 4 条 warning、6 条 info。完整视图实测覆盖草稿、展开内容、滚动和侧栏宽度保留，标签来源恢复、菜单关闭、对话切换及键盘进出。新增浮动菜单、拖动吸附与回答预览交互作为同一场景的延伸验证。最后截图复核发现原侧栏的离散关闭动画短暂占据宽度，现已在完整视图关闭该过渡，断言侧栏隐藏且审查面板从 x=4 开始；浮动模式隐藏原输入框外侧的模型统计，避免挤进浮窗。

0.2.171 发布前精简：删除重复状态更新和无用 DOM/CSS，集中新增快捷键迁移并接入旧设置转换脚本，复用已解析 patch，以 Map 查找 Git 状态，缓存标签排序并减少流式回复和拖动的无效遍历。精简后通过 222 项相关单测、6 个后台 Electron 场景及 check/build；既有视觉、任务隔离和关闭动画行为保留。
