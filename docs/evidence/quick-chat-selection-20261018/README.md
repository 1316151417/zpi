# VS Code 选区复制与原生键盘焦点排查

基于 main `187716a` / 0.2.116，分支 `codex/fix-vscode-quick-chat-selection`。交付 v0.2.117。本机已验证 VS Code 复制带入、键盘焦点、长文字末尾定位和跨 Space 唤起。

## 本机证据

用户明确缩小范围：Codex 可带入，VS Code 的源码 / Markdown 编辑区失败，截图和剪贴板入口正常。本机 VS Code 1.142.0，主进程 PID 27954；排查开始时 ZPI 主目录客户端 PID 25535。

在原选区助手上加了不含正文的诊断，原读取顺序不变。实体 C 回调留下 [阶段记录](native-selection.jsonl)：

- Codex：trusted=1，focusedStatus=0，selectedStatus=0，role=AXGroup，成功。
- VS Code 两次：trusted=1，focusedStatus=-25212（kAXErrorNoValue），在应用焦点读取阶段失败，尚未查询选中文字。
- 一次对照实验：仅在 NoValue 时设置 AXManualAccessibility=true。请求返回 0，但同次重读焦点仍为 -25212；用户反馈仍报错。
- 后续 VS Code 的 focusedStatus=0、role=AXTextArea、selectedStatus=0，但结果为 empty；用户反馈没有反应。

因此不能归因于快捷键丢失或主进程未获授权。当前 AX 读取路径不足以覆盖本机 VS Code 编辑器，也不能将一次 AXManualAccessibility 成功返回当成选区已可读取。未保留接口启用实验；对照期间曾恢复原算法，仅暂留诊断，最终替换为用户确认的 Copy 语义。

CUA 观察到编辑器标签为「The editor is not accessible at this time. To enable screen reader optimized mode, use Shift+Option+F1」，状态栏同时显示 70 selected。另见两个尚未关闭的同步采集错误框；关闭第一个后，第二个排队提示才出现。`dialog.showErrorBox` 的同步错误展示需要一并处理，避免把被错误框阻塞的后续操作当成未收到按键。

自动化只新建并丢弃一个未保存测试页（内容为固定测试文字），没有改写现有文件；其标题、可访问子树与后台窗口截图存在更新不一致，不将这部分自动化观察当成实际全局键通过。

## 用户确认的复制语义

用户明确要求 Option+Shift+C 执行复制，保留新剪贴板，不恢复旧内容。因此撤掉 AX 选区读取和接口启用实验，改用小型原生助手向当前应用发送 Cmd+C；只有剪贴板 changeCount 更新且产生稳定文本才带入。助手不清空、备份或恢复系统剪贴板；前台应用改变时退出。1 秒为无响应 Copy 的上限，不是成功路径固定延时。无更新、无文本、空文本、焦点变化静默结束；权限/构建等错误使用已有浮窗内提示，不创建原生模态错误框。VS Code 无选区时可能执行其原本的整行复制，遵循目标应用 Copy 语义。

对照助手在 PID 25535 进程下三次得到成功结果，用户确认“没问题”，并确认剪贴板保留。随后用户报告打字进入原编辑器，故这一轮不能标为整体验收通过。

## 键盘焦点基线

撤下复制实验后，普通 Option+Space 收起/恢复仍不能输入。再保存 106 字草稿、重启客户端 PID 30852，在尚未调用复制助手前，用户仍报告“先输入几个测试字，我都输入不了”。因此复制事件不是已证实的唯一原因，也不能归因于之前错误框残留。

[重启后旧显示逻辑记录](native-focus-before.jsonl)显示：三次 open 的 show 分别在 6.851、3.462、4.323 ms 完成；原生 focused=true，renderer-focus/frame 亦已确认，但实体输入期间没有一条 native-keydown。renderer 焦点、Electron isFocused 不能证明 OS 键盘路由正确。没有用自动化指定 PID 的按键当作实体输入证据。

Electron 41.10.7 的 [Show/Focus 实现](https://github.com/electron/electron/blob/v41.10.7/shell/browser/native_window_mac.mm)对 panel 跳过应用激活，IsFocused 仅检查 Cocoa isKeyWindow。当前对照在 show 后显式 app.focus，再聚焦面板，即便 isFocused 已为 true；保留取消/Space 隐藏检查。PID 61561 启动并恢复原草稿后，用户实体键盘确认普通输入和 VS Code C 带入后输入均正常（“好了，没问题”）。[修复后记录](native-focus-after.jsonl)包含 5 个 native-keydown 到达事件、两次草稿单次交付和多次普通唤起。这次采样结束前未发出自动化按键；恢复草稿使用 AX setValue，不产生 before-input-event，因而这些不是指定 PID 的合成按键。随后用户确认长文字与跨 Space 两项均“正常”：主窗留在另一桌面，Option+Space 不跳回该桌面且可输入。补充状态见 [最后验收阶段](native-final.jsonl)；该段包含人工操作以及此前一次用于载入 renderer 优化的 Cmd+R，不将其中任意键盘事件都断言为实体输入。

## 自动验证

- 两个新增用例先在旧逻辑失败：旧适配器接受未确认 Copy 的 AX 文本；旧 renderer 不展示导入错误。
- 焦点顺序用例也先失败：旧逻辑在 isFocused=true 时只调用 show，缺少应用激活和重新聚焦。
- 复制/内联提示改动：全量单元测试 265 文件、3351 通过/1 跳过；后台 Electron 的 capture、quick-chat、shortcuts 9 通过；check/build 通过（原有 4 warning/6 info）。
- 增加应用激活后，全量单测 265 文件、3354 通过/1 跳过，check/build 通过。实体输入、主窗不被带出和跨 Space 人工对照通过。
- 最终长文字改动后 renderer/capture 定向单测 160 通过；后台 Electron 9 通过，显式原生窗口交互 3 通过（使用 app API、假模型，不注册全局键）；check/build 通过。
- 长文字带入的真实 Electron 用例先在旧接收逻辑失败：光标已到末尾，但 bottomVisible=false，尺寸测量恢复了旧 scrollTop。因此在离散导入提交及尺寸测量后显式聚焦、设定光标末尾、滚动到底部；不改普通编辑时的光标。

资料：[Apple AX 查询](https://developer.apple.com/documentation/applicationservices/1462085-axuielementcopyattributevalue)、[Electron 可访问性接口](https://www.electronjs.org/docs/latest/tutorial/accessibility)、[VS Code 可访问性模式](https://code.visualstudio.com/docs/configure/accessibility/accessibility)、[Apple pasteboard changeCount](https://developer.apple.com/documentation/appkit/nspasteboard/changecount)。Electron 的原生实现还表明接口启用可能经去抖后异步生效，不能用成功返回值替代就绪证据。

## 最终行为与边界

用户确认 C/V 带入长文本后末行可见且能继续输入；普通 Option+Space 只恢复原光标、滚动位置和内容，用户再次确认符合预期。最后一项只在离散内容带入后同步提交并滚动，不改普通恢复或编辑时的位置。

未访问真实付费模型、未发送测试草稿、未删除实际会话；当前客户端草稿先保存后完整恢复。测试继续使用临时目录与假模型。主目录原生诊断产物已恢复原版，未改写其 Git 工作区。没有保留选区正文或剪贴板正文到本记录。

仍未验证：全屏 Space、多显示器、不同输入法和第三方剪贴板管理器并发更改。CGEvent Copy 遵循目标应用的复制行为，无法保证绕过其自定义 Copy 拦截；未产生新文本时保持静默。
