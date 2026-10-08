# 自动预览与侧边栏：实现和验收

参考版本：ZCode `872ad960de7ec172591f7e1952f7849229f94521`，3.14.0。只读取参考仓库，没有修改；其原有未跟踪项 `.zcodeignore`、`study/` 保持不变。实现位于当前 zpi 工作树，未提交 commit。工作开始时 zpi 工作树干净。

先完成 [spec](../../specs/assistant-previews-and-sidebar.md)，再补行为测试和实现。spec 包含产品规则、状态所有者、接口、事件顺序图和验收对照表。没有引入遥测、MCP、子代理或后台编排。

## 能力与代码

| 范围 | 实现 | 验收证据 |
| --- | --- | --- |
| 整轮自动卡片 | `Conversation.tsx` 合并本轮全部文本，在最后一段助手文本下渲染；运行中不展示，完成/中断后校验 | `preview-lifecycle.spec.ts`：前段引用、工具执行、最终无引用文本，仍只在末尾出卡；流式/中断/历史切换 |
| 文件引用识别 | `packages/ui/src/preview/` 移植源解析器、路径和指令规则；复用现有 file-citation | `assistant-preview-cards.test.ts`：相对/绝对/Home/Windows/空格/中文/编码/file URL/行号/指令 |
| MD/HTML 变更门槛 | Renderer 读取现有 `getChanges(sessionId, runId)`；排除撤销、删除、不可用快照；文件名仅唯一匹配 | 单测：无变更、歧义；桌面：真实 write、仅讨论、rewind、读取失败 |
| localhost 网站 | 保留原始 URL/路由/query；合法端口、无凭据、排除外网；按源规则抑制 HTML 卡片，不探测连通性 | 单测 URL 矩阵；桌面 BrowserPane 实际载入原 URL，离线服务仍能出卡 |
| 顺序、去重、数量 | 反向引用位置、规范路径/URL 去重；15 候选，批量 stat 后最多 10 张 | 15→10 和一次批量调用单测；迟到 IPC 响应、切换和重复投影桌面测试 |
| 生命周期 | 语义键合并在途请求，组件拥有已校验快照；卸载后返回重新 stat；history reset 清理请求；旧响应不发布 | 文件在另一会话期间删除后返回不再出卡；排序重投影不重复校验；迟到结果不串会话 |
| 默认/下拉打开 | `preview-services.ts` 接入 pane-store；Markdown→FilePane、HTML/URL/PDF→BrowserPane、DOCX/XLSX→OfficePreview、音视频→媒体预览、PPTX→原生打开；菜单列出已安装 App、复制路径 | `preview-sidebar.spec.ts`、`preview-formats.spec.ts`：真实临时文件、DOCX 正文、XLSX canvas、audio readyState、videoWidth、PDF webContents、剪贴板与原生 API 边界 |
| PPTX 自动打开 | 只响应当前可见会话观察到的 running→completed；最终可见 PPTX 签名纳入一次性消费键 | 完成后调用一次原生打开，刷新/历史恢复不重复；冷历史/中断不触发的单测 |
| 筛选和排序 | `TaskViewMenu.tsx`，源尺寸/ListFilter/SVG/文案/Radix 菜单；视图和排序独立保存，非法值默认回退 | 菜单键盘、Escape、选中状态、切换、reload 和完整应用重启桌面测试 |
| 项目和时间线 | `App.tsx`、`SidebarTaskList.tsx`；保留已有置顶、归档、项目和分区操作；任务分区为平铺列表 | 实际 JSONL 会话夹具；切换后打开真实历史任务；原 sessions 回归用例 |
| 排序和时间 | `sidebar-task-model.ts` 单一排序器；真实运行优先；运行中只比较 createdAt/id；普通行一直显示 updatedAt | 相同时间决胜、并发活动不换位、相对时间边界；session-activity/renderer-store 单测 |
| 活动事实 | SessionHost 发带 activityAt/seq 的现有事件；HistoryIndex v7 从 JSONL message/run 恢复活动时间；元数据不改变活动 | 重命名、置顶、已读和重启；持久化 running 不作实时证据；迟到列表快照保留更新的活动和运行状态 |
| 三种分页 | 项目 5+5、任务 20+20、时间线 20+20；项目独立，折叠/移除/切视图按源规则重置；到底隐藏 | 5/6/10/11、20/21/40/41 单测；11+6+41 条真实会话桌面分页；过期 hasMore/加载中条件单测 |
| 时间线分组 | 本地日历边界、中文周一/英文周日、源判断顺序；排序分页后按首次出现分组 | 全部日期桶、跨日/周/月/年、语言差异、运行优先与分组合并顺序 |
| 样式和素材 | Scoped CSS，源 Zai 深浅主题；两种行布局、渐隐及 hover 跑马灯、hover/focus 操作位、触屏时间；源 Lucide 路径和已有 Material SVG | 以下 22 组源码组件对比、计算样式与 SVG 测量；1146 个素材四份逐字节校验 |

主要修改文件组：

- UI：`packages/ui/src/components/{Conversation,AssistantPreviewCards,TaskTitleOverflowText}.tsx`、`preview/*`、`preview-cards.css`、`file-citation.ts`、公共类型和导出。
- Renderer：`App.tsx`、`SidebarTaskRow.tsx`、`SidebarTaskList.tsx`、`TaskViewMenu.tsx`、`task-view-icons.ts`、`sidebar-task-model.ts`、`preview-loader.ts`、`preview-services.ts`、`store.ts`、`pane-store.ts`、`workbench.css`。
- Main/IPC：`history-index.ts`、`session-host.ts`、`preview-files.ts`、`file-open-apps.ts`、`file-preview.ts`、main/preload `index.ts` 和 `shared/bridge.ts`。
- 测试、spec、可重跑验证脚本、证据和 `THIRD_PARTY_NOTICES.md`。DOCX/WebM 夹具为本次生成的最小测试文件。

## 实际执行结果

环境：macOS arm64，Node 24.12.0，npm，Electron 41.10.7。

| 检查 | 结果 |
| --- | --- |
| `npm run check` | TypeScript + Biome 通过 |
| `npm run test:unit` | 66 个文件，332 项通过 |
| `npm run test:desktop -- …` | 构建成功；8 个相关桌面测试文件中的 20 项通过。随后补充整轮文本锚点和动画断言，两个相关文件的 5 项再次通过；共覆盖 21 个不同用例 |
| `npx electron-builder --mac dir` | 成功生成 `release/mac-arm64/ZPI.app`，按项目配置未签名；未生成发行 DMG |
| `ZPI_TEST_PACKAGED_APP=… npx playwright test …` | 3 项通过；应用先复制到仓库外临时目录再启动；覆盖真实文件预览、打开菜单、分页、偏好和重启 |
| `node scripts/verify-preview-assets.mjs` | 1146 个 SVG 在 ZCode、zpi public、dist、app.asar 中逐字节一致；[资产清单](assets.json) |
| `node scripts/verify-preview-sidebar.mjs` | 22 组浅色/深色对照；测量、图像和统计见 [evidence.json](evidence.json) |
| `git diff --check` | 通过 |

初次全量单测曾有未修改的 `workspace-files.test.ts` 模糊搜索用例失败：随机临时目录下查询 `escape-folder` 匹配到了 `empty-folder`。该文件单独 6 项、后续两次完整单测均通过；未改动相关搜索实现。首次完整桌面运行有两个新增用例在菜单关闭动画尚未完成时过早再次点击；测试已改为等待菜单卸载，无固定 sleep，之后完整 20 项通过。构建有依赖中的 `use client` 警告，打包有重复依赖提示，均不导致失败。

通过运行的输出摘录保存在 [verification.log](verification.log)。桌面构建日志仅摘录测试段，完整警告不重复保存。

可重跑命令：

```sh
npm run check
npm run test:unit
npm run test:desktop -- tests/desktop/preview-sidebar.spec.ts tests/desktop/preview-lifecycle.spec.ts tests/desktop/preview-formats.spec.ts tests/desktop/sessions.spec.ts tests/desktop/changed-files.spec.ts tests/desktop/file-preview.spec.ts tests/desktop/message-actions.spec.ts tests/desktop/assistant-flow.spec.ts
npx electron-builder --mac dir
ZPI_TEST_PACKAGED_APP="$PWD/release/mac-arm64/ZPI.app" npx playwright test tests/desktop/preview-sidebar.spec.ts tests/desktop/preview-formats.spec.ts
node scripts/verify-preview-sidebar.mjs /Users/jiezhou/VSCodeProjects/ZCode
node scripts/verify-preview-assets.mjs /Users/jiezhou/VSCodeProjects/ZCode
```

## 视觉对照

固定时钟 `2026-10-08 12:00 Asia/Shanghai`，窗口内容 1200×800，侧栏 280px（窄栏用例 180px），UI 字号 14px，缩放 100%，系统字体，Retina DPR 2。截图每侧 2400×1600。**左 ZCode，右 zpi**；overlay 是 50% 叠图。

验证脚本直接编译只读 ZCode 源组件：AssistantPreviewCards、OpenSplitButton、TaskListItem、TaskTitleOverflowText、DropdownMenu；菜单使用 WorkspaceSidebar 的实际 JSX，时间线调用源分组函数。项目/时间线外围布局使用源 class 列表。加载源完整主题 CSS，平台服务和数据注入固定夹具。**这属于源码组件运行对照，不是完整 ZCode 应用的端到端截图。** 真实 zpi 应用的状态/IPC/文件打开另由上面的桌面测试覆盖。

| 场景 | 浅色并排 | 深色并排 | 每张超阈值像素数（浅/深） |
| --- | --- | --- | --- |
| 自动卡片 | [查看](cards-light-comparison.png) | [查看](cards-dark-comparison.png) | 1 / 1 |
| 打开菜单 | [查看](open-menu-light-comparison.png) | [查看](open-menu-dark-comparison.png) | 3 / 3 |
| 筛选排序菜单 | [查看](sort-menu-light-comparison.png) | [查看](sort-menu-dark-comparison.png) | 0 / 0 |
| 项目列表/更多 | [查看](projects-light-comparison.png) | [查看](projects-dark-comparison.png) | 0 / 0 |
| 普通任务行 | [查看](tasks-light-comparison.png) | [查看](tasks-dark-comparison.png) | 0 / 0 |
| 时间线 | [查看](timeline-light-comparison.png) | [查看](timeline-dark-comparison.png) | 0 / 0 |
| hover | [查看](tasks-hover-light-comparison.png) | [查看](tasks-hover-dark-comparison.png) | 0 / 0 |
| focus | [查看](tasks-focus-light-comparison.png) | [查看](tasks-focus-dark-comparison.png) | 0 / 0 |
| hover:none 触屏 | [查看](tasks-touch-light-comparison.png) | [查看](tasks-touch-dark-comparison.png) | 0 / 0 |
| 180px 窄栏 | [查看](tasks-narrow-light-comparison.png) | [查看](tasks-narrow-dark-comparison.png) | 0 / 0 |
| 任务 20 条/更多 | [查看](tasks-page-light-comparison.png) | [查看](tasks-page-dark-comparison.png) | 0 / 0 |

阈值为任一 RGB 通道差值 >16/255，每张比较 3,840,000 个像素；0 表示没有超过这个阈值的像素，不表示所有字节完全一致。卡片/菜单边缘仍有上述微小差异。截图关闭动画以便稳定比较；动画时长和逐张延迟另通过真实浏览器计算样式断言。完整原图、并排图、叠图全部保留在本目录。

真实 zpi 应用补充截图：[卡片浅色](app-previews-light.png)、[卡片深色](app-previews-dark.png)、[打开菜单](app-preview-open-menu.png)、[排序菜单](app-sidebar-sort-menu.png)、[时间线浅色](app-sidebar-timeline-light.png)、[时间线深色](app-sidebar-timeline-dark.png)。这些来自真实任务和临时文件的桌面测试，不参与上述组件像素差分统计。

## 源码细节与边界

- 提示中的 TaskTitleOverflowText 实际在源 `components/` 下。它还包含 1 秒后开始的标题跑马灯，本次一并移植。
- 日期标题是 `2 天前` / `3 天前`，有空格。分组按排序后第一次出现的顺序，运行任务可能让较旧日期组排在今天之前。
- Archive 在 JSX 中写了 14px，但源 Button 的实际生效规则把 SVG 设成 12px；按实际渲染对齐。Lucide 更新改变了 MessageCircleCheck 的勾形，本次专门保留源 1.17 的精确 SVG，不替换全应用图标版本。
- 显式引用和普通 prose 对 `~/` 的支持不同，按源解析规则保留，没有自行扩展语法。纯 localhost 地址不做文件 stat/服务连通性探测；关联实际 HTML 路径的候选按源规则参与 stat。
- zpi 无远程工作区服务、任务等待交互协议和 ZCode 分组平台；没有复制这些系统。保留已有多本地会话同时运行和置顶/归档边界；菜单不额外添加状态筛选器。现有分区管理及项目操作继续使用 zpi 原实现。
- zpi 没有内嵌 PPTX 渲染器，使用原生打开链路。测试覆盖到 Electron `shell.openPath/showItemInFolder/openExternal` 调用边界，并在测试中拦截这些 OS 调用；没有声称验证 PowerPoint/Keynote 窗口内的最终内容。DOCX/XLSX/PDF/音视频实际加载和渲染已经验证。
- 本机实际可用 App 由 Main 发现，图标取系统应用图标。仅在 macOS arm64 做过原生集成验证；Windows 路径解析有单测，Windows/Linux 的桌面运行及编辑器发现未在本次环境验证。没有移植远程、WSL 或 CLI 编辑器启动编排。
- 所有文件检查、读取和原生打开通过 preload/IPC，Renderer 没有文件系统访问。沿用 zpi 原有预览大小和格式限制。
- 本报告提供范围内的实现和可复核证据；存在上述平台边界、组件夹具限制及少量像素差异，因此不宣称“完美一比一”。
