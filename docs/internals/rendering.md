# 流式渲染、Markdown 与阅读位置

使用入口：[界面和通知](../features/appearance.md)。历史读盘见[History Worker](history.md)。

## 快照与增量

主进程把高频 delta 合并，默认约 30 毫秒一批，最多 256 个事件或 128K UTF-16 字符；遇到非 delta 边界先 flush，保证 start/end、工具、错误和压缩事件顺序。

renderer 从快照水位开始，只应用更新的批次。仅连续且同身份的 delta 可以合并，不能跨消息或工具边界拼接。窗口崩溃时暂停发送，导航提交后清理旧接收状态，重建界面重新取快照。

侧栏活动时间可约五秒节流，真正的完成、失败、输入接受等边界立即更新。不能让流式正文每个字都触发全部任务行重排。

## reducer 和消息展示

共享 UI reducer 将 Agent 事件投影成 RunView。正文、推理、工具过程、文件变更、来源和排队输入使用明确结构，不从已渲染 HTML 反推业务状态。错误通过用户提示组件展示，工具失败与助手中断有不同表现。

文本流展示要保留用户选区稳定性：选中的旧内容不应因新 token 改写对应 DOM。工具输入预览是部分参数的展示，不能成为执行依据。动画尊重 reduced-motion 偏好。

同一次模型响应内相邻的推理条目在展示层合并成一个思考块，正文、工具调用、响应边界和压缩标记会断开合并。合并块沿用首项身份，显示最新摘要和整段耗时；原始 RunView、会话记录及协议回放使用的推理签名保持完整。

## Markdown、代码、公式和图表

Markdown 统一配置链接、表格、图片、代码 fence、数学公式和 Mermaid。路径链接先分类，系统打开经过主进程；普通网页链接不解释为本地文件。复制表格、代码与正文分别使用语义文本。

代码语言识别和 Diff 高亮复用独立工具。Mermaid 有输入和渲染预算，异步错误只影响图表块。数学及图表库的缓存、可见性与组件销毁需要配合，避免流中每次渲染重建全部重资源。

## 长历史的 DOM 窗口

加载超过约 40 个 turn 后启用窗口化，保留可视区域上下约 1200 像素，最新四轮、当前运行、正在选择/聚焦/编辑的内容继续挂载。卸载块保留测得高度，减少滚动跳动。

这只限制 DOM 成本，不等于释放所有历史数据。磁盘分页、RunView 内存、Markdown 缓存和 DOM 挂载是四个不同层面，优化时需分别测量。

## 主题、侧栏与通知

主题设置应用到 documentElement 的 data-theme，字号写入 CSS 变量；system 模式监听 prefers-color-scheme。共享 appearance 订阅观察根节点变化，多个组件复用一个 observer，最后一个订阅释放时断开。终端、代码和审查还有各自选项，不能只改页面背景就认为全部原生/渲染表面已同步。

侧栏任务行按任务身份订阅活动、未读、归档、置顶和分组状态，长列表按可见区渲染。拖动排序改变业务顺序，不用每次流更新的时间戳重排用户手动顺序。

系统通知仅处理 settled，且应用所有窗口都没有焦点、用户开启通知、系统支持时才发出。error 显示失败，其他结束（包括手动停止）显示完成。按状态与 session 在三秒内去重，最多持有 100 个活动通知对象。

系统通知本身 silent，renderer 根据单独声音开关播放内置提示音；播放失败不影响任务。点击通知恢复窗口并定位任务；dispose 清理通知和监听。测试的系统呈现拦截见[隔离](testing.md)。

## 阅读位置

日常增长优先利用 Chromium scroll anchoring；向前加载历史和搜索跳转使用明确锚点。书签保存 turn ID 与局部偏移，兼容旧像素位置；约 250 毫秒节流并在必要生命周期 flush。

历史补页应恢复读者正在看的位置，只有用户处于跟随底部状态时才自动跟随新回答。搜索、文件备注和文本选择不能被“新 token 到达”强制拉回底部。

源码：[事件批次](../../packages/desktop/src/main/event-batcher.ts)、[UI reducer](../../packages/ui/src/reducer.ts)、[Conversation](../../packages/ui/src/components/Conversation.tsx)、[历史容器](../../packages/ui/src/components/ConversationHistory.tsx)、[Markdown](../../packages/ui/src/components/Markdown.tsx)、[阅读位置](../../packages/ui/src/reading-position.ts)。回归：[批次](../../tests/desktop/event-batches.spec.ts)、[历史 DOM](../../packages/ui/test/conversation-history-dom.test.ts)、[阅读位置](../../packages/ui/test/reading-position.test.ts)、[选择稳定](../../packages/ui/test/selection-stable-preview.test.ts)。
