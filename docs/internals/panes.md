# 标签身份、完整视图与原生面板

使用入口：[面板和浏览器](../features/panes.md)。

## 标签属于任务

pane-store 保存每个任务的标签、当前选择和最近关闭记录，最多保留八个关闭项。标签描述内容来源，不保存可跨重启复用的原生对象句柄。

文件、单次工具 Diff、run 聚合 Diff、审查来源、辅助对话等有不同 source identity。相同路径但不同任务/run/tool 不能错误合并。一个标签导航到新文件后，复用判断基于它当前内容，不再按创建时旧 ID 抢占该标签。

关闭与恢复通过各内容类型自己的创建/清理路径完成。复原浏览器或终端标签会重新创建资源，不保证之前的网页进程或 shell 继续存在。

## 原生浏览器视图

参考 ZCode，renderer 使用稳定挂载的 `<webview>` 承载网页，参与 DOM 布局、裁剪和弹层合成。打开标签总览、搜索或其他菜单时保留网页画面，不因弹层出现隐藏整页，也不销毁或重新加载网页。

PaneServices 在 main 持有浏览器登记与 guest WebContents，renderer 在 guest 就绪时提交标签 ID、guest ID 和可见状态。main 校验 guest 属于当前主窗口、类型为 webview 且使用指定独立会话；挂载前强制沙箱、禁用 Node/嵌套 webview 并移除 preload。导航、弹窗路由、状态事件和快捷键仍由 main 处理。空标签首次导航才创建 guest，之后 URL 变化不替换节点或重设 src。

切换任务、标签或完整视图只改变 DOM 可见性，保留网页输入、历史和 guest 身份；可见状态只用于焦点与快捷键提示。关闭标签、主 renderer 重载或崩溃时清理资源。验收覆盖菜单展开时的宿主合成像素、搜索与选择、Esc 关闭、窄窗口、网页草稿与历史保留、安全隔离和资源释放。

浏览器仅供用户查看与操作，没有向 Agent 注册浏览器控制工具。终端的 PTY 生命周期见[后台与终端](background-terminal.md)。

## 完整视图

完整视图复用现有对话和输入框实例，通过布局切换将当前对话作为标签呈现。草稿、选区和对话订阅不因切换重新创建。浮动输入框的位置、展开/收起状态和宽度约束由统一状态维护。

左栏与右侧分栏有各自偏好；进入完整视图不覆盖普通布局的比例。隐藏的任务顶部栏对应菜单命令也禁用，快捷键必须查看真实可见交互上下文。

## 异步 scope

文件读取、PPTX 校验、浏览器创建、PTY 订阅都可能晚于切换。回调必须比较任务、标签和操作 epoch，过期结果释放资源或丢弃，不能只判断组件还 mounted。

源码：[pane-store](../../packages/desktop/src/renderer/pane-store.ts)、[完整视图](../../packages/desktop/src/renderer/pane-full-view.ts)、[RightPane](../../packages/desktop/src/renderer/RightPane.tsx)、[原生服务](../../packages/desktop/src/main/pane-services.ts)、[BrowserPane](../../packages/desktop/src/renderer/BrowserPane.tsx)。回归：[隔离](../../packages/desktop/test/pane-isolation.test.ts)、[完整视图](../../packages/desktop/test/pane-full-view.test.ts)、[标签交互](../../tests/desktop/pane-tabs-drag.spec.ts)。
