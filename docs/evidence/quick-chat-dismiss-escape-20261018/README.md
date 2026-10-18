# 快速对话收起与运行中 Esc 验收

基线 main `b54bd93` / v0.2.117；修复 v0.2.118，分支 `codex/fix-quick-chat-dismiss-escape`。

## 原生复现与根因

本机 macOS/Electron 41.10.7，使用隔离数据、统一交互启动器与本地假模型。旧版通过真实 IPC 收起快速面板后，[单应用记录](native-before.json)显示 quick visible/focused=false、main visible/focused=true；事件为 blur:1 → focus:2 → blur:2 → focus:1，没有新的 main show 或 app activate。v0.2.117 为修复实体输入仍进入其他编辑器而激活应用；面板消失时 Cocoa 随后把同进程主窗提到前台。

进一步启动两个独立的隔离 Electron 应用 A（被测 ZPI）和 B（来源应用），B 的窗口遮住 A 主窗。测试通过 WindowServer 前后顺序与前台 PID 区分“主窗原本可见但被遮住”和“收起时主窗被提到前台”，不只看 `BrowserWindow.isVisible()`。用 `git show b54bd93` 的 main/window 源码构建旧版，被同一新测试稳定复现：[旧版外部应用记录](native-v117-external.json)中，打开时 A 主窗仍在 B 后面；隐藏面板后 A 主窗获得焦点并移到 B 前面，来源应用未恢复焦点，测试失败。不是打开时主窗被误显示，也不是全局键重复注册。

最终修复在激活快速面板时保留来源 `NSRunningApplication`，主动收起前用公开 AppKit API 归还焦点，再隐藏快速面板。首次来源归属保留到本次收起；重复呈现不覆盖；目标退出或本进程已非活动应用时不激活它。真实失焦、Space 变化、程序收起及后台测试不归还焦点；系统直接隐藏面板时也释放旧来源，避免下次归还到过期应用。归还抛错仍执行面板清理，但旧清理不能隐藏重入的新唤起。没有新增等待、任意延时或主窗显隐操作。

[修复后双应用记录](native-focus-return.json)分别覆盖主窗原本可见和原本隐藏：打开后快速面板聚焦；收起后 B 恢复为前台，A 主窗保持原有可见性及位于 B 后面的顺序，A app hidden 始终为 false。再移开 B 的窗口，A 主窗仍保持原状态；显式 app activate 仍能显示主窗。依据：[固定版本 Electron Show/Focus/Hide 实现](https://github.com/electron/electron/blob/v41.10.7/shell/browser/native_window_mac.mm)、[Apple 焦点让渡](https://developer.apple.com/documentation/appkit/nsapplication/yieldactivation(to:))。

## 已撤回的实验

- 最初尝试 `app.hide()`，单应用检查看似通过，但它会隐藏整个应用所有窗口。[实验记录](app-hide-rejected.json)与用户实体键盘反馈确认两窗口一起显隐，不符合要求，已撤回；最终实现不使用它。
- 为区分打开时和收起时的窗口顺序，曾在隔离原生探针尝试操作窗口角色，错误把 `getNativeWindowHandle()` 的 NSView 当作 NSWindow，造成该隔离进程异常退出。用户看到的 Electron 崩溃提示来自此探针，实际客户端当时未加载该原生实验。最终依据旧版双应用证据移除了全部窗口句柄/角色逻辑；新模块仅保留应用激活与焦点归还，不访问 Electron 原生窗口指针。API 定义：[macOS 返回 NSView](https://www.electronjs.org/docs/latest/api/base-window#wingetnativewindowhandle)。

## Esc 语义

旧版 renderer 的 window keydown 无条件调用 hide。新增用例先在旧版失败：运行中两次 Esc，stop 调用为 0。修复复用现有 perform/stop；停止 pending 时合并重复 Esc，即便 settled 快照先于 stop IPC 返回也不隐藏。idle 且没有 stop pending 才隐藏。IME、repeat、菜单和对话框内部 Esc 保护保留；监听跟随 running/pending，避免初次 mount 捕获空闲状态；reset pending 仍可隐藏。

真实 Electron + 本地假 SSE 服务验证：生成中 → Esc → host run.status=aborted，原生窗口仍可见、下一问草稿保留 → 第二次 Esc → 原生窗口隐藏。未使用付费模型。原有“隐藏不中断流”的用例改为显式 hide IPC，保留其原意。用户已确认“esc功能没问题了”。

## 验证

- 后台 Electron：quick-chat、capture、shortcuts 共 9 通过。
- TypeScript/Biome/build：通过，既有 4 warning/6 info 不在本次修改范围。
- 全量单元：265 文件，3364 通过，1 跳过；系统直接隐藏后来源清理用例先失败，再修复通过。
- 原生交互：双应用窗口顺序与焦点归还、运行中 Esc、隐藏主窗后的输入、空白大窗折叠，以及显式主窗激活，共 5 通过。
- 双应用对照与运行中 Esc 属于真实 Electron/窗口/IPC，使用应用 API 或 renderer 输入，不冒充真实全局快捷键验收。
- 最终实体快捷键：用户在实际客户端完成 Option+Space 开/收、Option+Shift+Space 空白开/收及恢复输入，反馈“正常了”。[实际按键记录节选](manual-shortcuts.json)包含收到两种真实绑定、show/focus、toggle-hide/native-hidden，原生隐藏时 visible/focused/intent 均为 false，waiters=0。一次普通热唤起 show=2.487ms、focus=6.647ms；一次新建 show=7.441ms、focus=11.090ms。这是回调至对应方法阶段耗时，不冒充像素显示或实体输入延迟。

## 数据与边界

发现实际快速对话已有历史后，没有直接重启；说明内存临时会话会结束，用户明确选择“现在重启，可以结束当前临时对话”。没有删除磁盘实际会话，没有发送真实模型请求。原生窗口顺序记录只保留两个隔离测试 PID、层级及几何，不记录窗口标题、截图、剪贴板或输入内容。全屏 Space、多显示器及不同输入法仍未验收。
