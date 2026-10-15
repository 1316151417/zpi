# 快捷键事件路由与弹层边界

## 默认映射与升级

- Command/Ctrl+[ 切换左栏，Command/Ctrl+] 切换右栏，Command/Ctrl+K 搜索任务，Command/Ctrl+J 打开草稿输入框的本地环境菜单，Command/Ctrl+L 打开当前输入框的模型选择。Command/Ctrl+U 打开已有任务顶部的三点菜单。菜单内 ↑↓ 移动、→ 进入子菜单、← 返回、Enter 确认、Esc 关闭并恢复原焦点。
- Command/Ctrl+I 主动聚焦当前主任务输入框；全局窗口快捷键恢复有效原焦点，只有原目标失效时回退主输入。隐藏窗口与可见设置/弹窗期间不抢焦点。
- 离线迁移旧配置时，按历史版本只替换仍等于旧默认的绑定，保留自定义、null 及总开关。候选整体校验失败时保留全部旧绑定，不做部分迁移。
- 新增 focus-composer 缺项先补平台 I；已有自定义占用 I 时补 null，不覆盖旧键。新增 configure-environment 缺项补平台 J，被自定义占用时补 null。迁移版本存于 SQLite app 设置中。当前版本只补新增 task-menu 缺项（平台 U，已被占用则 null）；读取时不改写原设置，下一次设置保存时持久化。
- 提示继续由共享 formatter 根据实际配置生成。自定义分号及方括号组合按物理键匹配；Shift/Alt、IME 和重复触发边界不变。


## 快捷键设置页

- 以 ZCode 四列表格为视觉基准；保留 ZPI 命令清单、单绑定模型和显式保存。标题右侧为总开关，搜索右侧的键盘按钮用于按实际组合键过滤。
- 文本搜索同时匹配命令名、原始绑定及平台符号；按键过滤与文本条件取交集，清空搜索恢复列表。按键搜索 Backspace 清除组合，Esc 退出捕获。
- 表格区分系统全局、应用内、输入框、新任务输入框及任务面板；这些标签描述现有触发范围，不扩大范围。
- 编辑冲突留在行内，展示候选键位与错误；可继续重录或 Esc 取消，不抢绑其他命令。清除只移除绑定，命令保留。全部恢复默认先确认、保留总开关状态，再由保存提交。
- 捕获期间暂停原生菜单与系统全局注册；录入和按键搜索互斥。保存失败保留草稿，注册失败不覆盖原设置。
- 模型菜单（主/辅助输入框）、本地环境菜单（含分支搜索）、任务搜索、当前对话查找和任务菜单支持再次按自己的快捷键关闭。菜单只接收属于自身及其子菜单的事件；消费长按重复但不重复执行。普通发送动作不变。

## 停止回复

- Shortcut settings remain the only binding owner. The current stop callback continues to choose the main or focused auxiliary conversation.
- Bare Escape runs after local dismiss/cancel handlers, so dismissing a menu, dialog, suggestion or edit does not also stop a reply.
- A configured non-Escape stop shortcut is consumed in the document capture phase, before editors or terminals handle the same combination. It must not insert text or fall through to another action.
- Held non-Escape shortcuts are consumed without repeated stop dispatch. Composition events, key code 229, disabled/unbound shortcuts, already-handled input and dismissible overlays do not dispatch stop.
- Tests exercise the actual stop hook and message-editor handler without launching Electron, including a valid Shift+Command/Ctrl+Enter binding that otherwise inserts a newline.

## 可见弹层

- Workspace, composer and stop shortcuts share the same visibility test for blocking overlays. Existing dialog/menu/listbox/settings scopes remain unchanged.
- Only rendered, visible blockers count. A pending assistant question in a hidden or inert pane/tab must not disable shortcuts in the active conversation or workspace.
- Hidden/inert/aria-hidden ancestors, absent layout boxes and CSS visibility:hidden/collapse exclude a blocker. Visible dialogs, menus, suggestions and settings continue to block commands, including during their exit animation.
- Node regressions cover hidden and visible blockers, mixed candidate order and the real workspace/composer routing functions. Hidden Electron regression exercises an inactive auxiliary question alongside the active main composer.

## 当前任务输入框与窗口焦点

### 行为

- `focus-composer` 是可配置的应用命令，默认 macOS Command+I，其他平台 Control+I；显式聚焦任务列表当前选中的主任务输入框，不创建或切换任务。
- 捕获阶段消费命令和重复按键，避免 contentEditable 原生斜体或终端 Control+I 的 Tab 输入。组合输入、额外修饰键、停用/清空绑定不触发。
- 原生浏览器 guest 复用现有 workspace shortcut 转发；只有显式聚焦命令把焦点交回宿主 WebContents。终端继续走 renderer 捕获路由。
- 全局窗口快捷键隐藏窗口时不改变焦点；显示/恢复窗口沿用 Electron 原生窗口和 WebContents 焦点恢复。主输入、辅助输入、终端、浏览器、其他控件保留原目标与光标，不强行回主输入。
- 显示后仅在原目标失效时兜底当前主输入：存活且可见的浏览器 guest 仍有焦点则保留；renderer 的有效 activeElement 保留；节点被移除、隐藏、禁用或退回 body 时才兜底。
- 设置、真正可见的对话框/问题卡、菜单、候选列表、命令面板与快捷键录制阻止聚焦穿透。隐藏保留的弹层不阻塞。
- 没有当前任务、窗口隐藏/销毁、不再是请求发起时的任务时不聚焦；不修改草稿或发送内容。清空 Command+I 不影响窗口恢复兜底，窗口命令与总开关继续按其自身设置生效。

### 机制与边界

复用 `zpi:shortcut` / `onShortcut`、workspace command 解析和 `store.focusComposer`。不新增全局焦点历史框架，不主动重建已关闭的控件。窗口显示通知只作有效性检查；隐藏不发显示通知。每次异步帧重新检查当前任务、文档可见性、阻塞弹层和恢复目标，避免延迟响应抢走新焦点。

Electron 的窗口恢复与 WebContents 焦点保留用于正常路径；本次验证限制为 Node 测试，不运行 GUI、不连接用户 Mac。实际 macOS 全局快捷键、跨应用恢复与浏览器 guest first responder 恢复仍需目标平台烟测。

### 定向验证

- Cmd/Ctrl+I 正常、重复、组合输入、额外修饰、停用/改键/清空；已有编辑器与终端捕获。
- 窗口显示、后台、最小化、隐藏、销毁及显示中销毁；通知只能在成功显示之后。
- 主/辅编辑器、终端 textarea、按钮保留焦点；原目标不存在、隐藏或禁用回退；无任务与任务切换不误聚焦。
- visible/hidden/inert/aria-hidden/layout/CSS 弹层与控件；设置、菜单、问题卡阻止穿透。
- native browser guest 显式命令转发与重复消费；有效 guest 恢复保留，关闭/隐藏 guest 不阻止兜底。

## Electron 依据

- [项目依赖版本 41.10.7 的 WebContents focus 文档](https://github.com/electron/electron/blob/v41.10.7/docs/api/web-contents.md#event-focus)：macOS 的 WebContents focus 表示窗口 first responder，切换应用/窗口不改变每个窗口的 first responder。此处复用该既有行为，不承诺 Node 测试验证了真实 OS 窗口恢复。
- [41.10.7 的窗口 show / focus / hide 文档](https://github.com/electron/electron/blob/v41.10.7/docs/api/base-window.md#winshow)：窗口层的显示聚焦与页面内编辑器聚焦分离。
- [41.10.7 的 WebContents focus / isFocused 文档](https://github.com/electron/electron/blob/v41.10.7/docs/api/web-contents.md#contentsfocus)：显式 Cmd/Ctrl+I 从浏览器 guest 交回宿主时使用页面焦点 API。

## 置顶任务按住显示提示

- 平时仅保留右侧时间；macOS 按住 Command、其他平台按住 Ctrl 时，前五个可切换置顶任务以实际配置的快捷键替换同一位置的时间。松开恢复；提示与时间共用右边界，不并排展示。
- 置顶顺序复用 `visiblePinnedTasks`，与实际 `pin-1` 至 `pin-5` 分派一致。自定义键位使用共享 formatter；总开关关闭、绑定为 null、无对应命令的任务不显示提示，不回退伪造默认键。
- 提示显示期间鼠标悬停/键盘焦点不将其替换为归档操作；松开后恢复原有 hover 行为。等待确认/停止计时的问题徽章优先，按住修饰键不卸载徽章，也不改变其 hover 行为。
- main 统一观察主窗口（包括终端）和原生浏览器 guest 的 `before-input-event` 与 `input-event`，通过独立 preload 订阅传送修饰键状态；后者覆盖绕过 Chromium pre-handler 的输入，包括 `rawKeyDown`。重复边沿幂等处理。renderer 不再以 DOM 键盘事件维护第二份状态；侧栏缓存依赖修饰键状态，单独按下/松开即可刷新。观察器不消费输入、不分派命令，不影响真实任务切换或录制。
- 直接使用事件中的聚合 meta/control 状态（或 modifiers 快照），不另行维护左右按键集合；左右同时按住时释放一个仍显示。窗口 blur/hide/minimize、当前输入源 loading/crash/destroy、guest 隐藏/关闭、禁用和录制切换清除提示；后台 guest 生命周期和 host/guest 内部切焦点不会清空前台状态；卸载取消订阅。
- 窗口恢复时若修饰键已按住，收到下一次原生键盘事件后才更新，不推断系统全局按键状态。两条事件路径仍来自 Chromium 键盘事件，不是独立 OS hook；若系统没有送入键盘事件，不能保证恢复其状态。
- Node 回归覆盖 Electron Input 事件形状、左右单键、双键释放、两条事件路径去重、host/guest 共享状态、guest keyUp 过滤前观察、生命周期清理、preload 订阅销毁、实际映射和禁用边界。Electron 桌面回归覆盖单独按下/松开，以及保持 Command 按住连续切换任务后的提示恢复；macOS Cocoa 修饰键事件模拟也验证了显示与恢复，物理键盘仍需手工验收。

### macOS 手工验收（待目标平台执行）

1. 有前五个可切换置顶任务时，在输入框、终端分别单独按左 Command，不按数字，应立即显示；松开应立即恢复时间。右 Command 同样验证。
2. 左右 Command 同时按住，释放一个仍显示，释放最后一个隐藏；重复操作不黏住。按 Command+1 至 5 只切换一次任务。
3. 在原生浏览器 guest 获得焦点时重复上述操作。关闭/切换/隐藏 guest、切到其他应用、隐藏窗口或最小化均不留残余提示。
4. 总开关关闭与快捷键录制期间不显示提示；重启、重新启用或结束录制后重新按住/松开仍正常。
