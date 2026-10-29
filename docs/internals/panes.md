# 标签身份、完整视图与原生面板

使用入口：[面板和浏览器](../features/panes.md)。

## 标签属于任务

pane-store 保存每个任务的标签、当前选择和最近关闭记录，最多保留八个关闭项。标签描述内容来源，不保存可跨重启复用的原生对象句柄。

文件、单次工具 Diff、run 聚合 Diff、审查来源、辅助对话等有不同 source identity。相同路径但不同任务/run/tool 不能错误合并。一个标签导航到新文件后，复用判断基于它当前内容，不再按创建时旧 ID 抢占该标签。

关闭与恢复通过各内容类型自己的创建/清理路径完成。复原浏览器或终端标签会重新创建资源，不保证之前的网页进程或 shell 继续存在。

## 原生浏览器视图

PaneServices 在 main 持有 WebContentsView，renderer 只传递受控导航、可见区域和动作。视图使用独立会话/安全配置，不带主窗口 bridge。新窗口、导航和地址规范化由主进程处理。

只有可见标签将有效 bounds 提交给主窗口；隐藏、遮挡、切换完整视图时调整原生视图，避免网页压住 React 菜单。主 renderer 重载或崩溃时清理相关资源，旧 sender 不能继续控制新视图。

浏览器仅供用户查看与操作，没有向 Agent 注册浏览器控制工具。终端的 PTY 生命周期见[后台与终端](background-terminal.md)。

## 完整视图

完整视图复用现有对话和输入框实例，通过布局切换将当前对话作为标签呈现。草稿、选区和对话订阅不因切换重新创建。浮动输入框的位置、展开/收起状态和宽度约束由统一状态维护。

左栏与右侧分栏有各自偏好；进入完整视图不覆盖普通布局的比例。隐藏的任务顶部栏对应菜单命令也禁用，快捷键必须查看真实可见交互上下文。

## 异步 scope

文件读取、PPTX 校验、浏览器创建、PTY 订阅都可能晚于切换。回调必须比较任务、标签和操作 epoch，过期结果释放资源或丢弃，不能只判断组件还 mounted。

源码：[pane-store](../../packages/desktop/src/renderer/pane-store.ts)、[完整视图](../../packages/desktop/src/renderer/pane-full-view.ts)、[RightPane](../../packages/desktop/src/renderer/RightPane.tsx)、[原生服务](../../packages/desktop/src/main/pane-services.ts)、[BrowserPane](../../packages/desktop/src/renderer/BrowserPane.tsx)。回归：[隔离](../../packages/desktop/test/pane-isolation.test.ts)、[完整视图](../../packages/desktop/test/pane-full-view.test.ts)、[标签交互](../../tests/desktop/pane-tabs-drag.spec.ts)。
