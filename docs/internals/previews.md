# 文件树、预览格式、备注与交付卡片

使用入口：[文件与预览](../features/files.md)。标签生命周期见[面板](panes.md)，Diff 见[审查](review.md)。

## 文件树数据流

main/workspace-files 读取目录和 Git 状态，renderer 的 tree hooks 管理展开、缓存、监听、刷新和可见行。初始只读根目录，展开后读子目录，不沿符号链接递归扫描。目录优先排序，压缩连续单子目录，删除文件保留状态行但不提供读取动作。

虚拟行高 28 像素，sticky folder 显示当前滚动位置的祖先链。监听只覆盖根和已展开目录，变化约 300 毫秒合并，目录刷新并发最多两个。折叠、切换 scope 和卸载会释放订阅，迟到响应必须检查请求所属目录状态。

文件管理器使用目录/预览双栏。目录默认约 192 像素，最大占 60%；窄宽度下最小栏宽按 `min(160, floor(width/3))` 计算。手动显隐和宽度偏好按 cwd 共享，选择文件不会自动折叠目录。

## 文件读取边界

主进程验证路径、文件类型和读取大小，renderer 不直接读盘。文本预览最多 2 MiB，过大文件需显示明确限制。二进制格式使用各自有界读取或共享文件接口；格式插件不能通过任意 URL 绕过本地文件边界。

Markdown 链接、图片、文件位置和代码引用先分类解析，再选择应用内预览、系统默认程序或网页浏览器。SVG 经过清理；外部资源和危险 href 不直接传给文档渲染器。HTML 文件页显示源码，网页运行走独立浏览器视图。

## 格式引擎

| 格式 | 管线 | 主要边界 |
| --- | --- | --- |
| 文本/代码 | FilePane 与代码显示 | 大小、行范围、语言识别、换行 |
| Markdown/Mermaid | 共享 Markdown 与图表组件 | 链接分类、图表预算、异步失败 |
| 图片/音视频 | 文件协议与媒体元素 | 实际文件类型、受控 URL、生命周期 |
| PDF | PDF.js、本地字体/CMap/WASM 资源 | 大于 2 MiB 时分段读取，页与缩放状态 |
| DOCX/DOC | 本地 Office 预览器 | 解析错误、外链与样式范围 |
| XLSX/XLSM/XLS | 工作簿解析、工作表模型 | 表切换及单元格展示 |
| PPTX | `@aiden0z/pptx-renderer`、ZIP 资源、slide 模型 | 按需页渲染、元素选择、缩略图、导出 |

PPTX 的控制、元素模型、引用和导出拆在 presentation 目录。它是只读预览，不提供 Office 原样编辑。旧 `.ppt` 不在支持范围内。格式解析失败由 FilePreviewBoundary 等局部边界接住，不应拖垮全部对话。

## PDF 导出

演示文稿经受控打印/导出管线生成 PDF，在同一窗口请求保存对话框。导出结果有 50 MiB 上限，取消与生成失败分别处理。目标文件由用户选择，不能用幻灯片内容自带的路径决定写入位置。生成任务核对当前预览身份，关闭/切换后丢弃不再适用的结果。

## 行备注

行号选择生成结构化引用，包含路径、行范围、选中文本和可选评论，加入目标会话草稿。选择范围要有非空白代码；空评论仍可作为代码引用。它不修改源文件，也不自动发送。

草稿引用与预览标记保持对应 ID，移除一条评论不能误删普通文字引用。主任务和辅助对话各有目标 scope；异步选区或文件切换不能把备注送到另一个输入框。

## 交付卡片筛选

从助手内容解析文件/URL 候选，按最近出现顺序去重并校验，候选最多 15，展示最多 10。Markdown/HTML 文件需有同轮实际文件变更；Office、PDF、媒体需满足存在与格式规则。普通文本和图片不因路径被提及就自动生成交付卡片。

网站卡片只接收允许的 localhost/127 地址与 HTTP(S) 形式，禁止 credentials，保留 path/query；不主动探测站点是否能打开。同轮网站卡片可抑制重复 HTML 卡片。

PPTX 自动打开只针对当前观察到的成功 run 完成，恢复历史、错误、取消不触发；异步验证要核对当前 run 和任务，防止旧结果弹到新任务。

源码：[文件服务](../../packages/desktop/src/main/workspace-files.ts)、[预览读取](../../packages/desktop/src/main/file-preview.ts)、[文件树](../../packages/desktop/src/renderer/workspace-file-tree/WorkspaceFileTree.tsx)、[文件容器](../../packages/desktop/src/renderer/FileManagerPane.tsx)、[PPTX](../../packages/desktop/src/renderer/presentation/pptx-engine.ts)、[PDF 导出](../../packages/desktop/src/main/preview-pdf-export.ts)、[卡片规则](../../packages/ui/src/preview/assistant-preview-cards.ts)。回归：[文件树](../../packages/desktop/test/workspace-file-tree.test.ts)、[预览](../../packages/desktop/test/preview-files.test.ts)、[PPTX 生命周期](../../packages/desktop/test/presentation-lifecycle.test.ts)、[卡片](../../packages/ui/test/assistant-preview-cards.test.ts)。
