# 快速对话的临时会话与窗口协调

使用入口：[快速对话](../features/quick-chat.md)。它有独立入口、preload、host、window 和状态投影，不借用主任务草稿。

## 临时运行时

会话不持久化 transcript，不加载项目资源或长期记忆，只装配限定的 read、bash 和可用联网工具。允许 bash 意味着仍有 shell 副作用，不能称为操作系统只读环境。默认工作目录在首次发送时创建为 `~/Documents/ZPI`。

按最后接受输入的单调时间判断 15 分钟过期；过期在下次用户打开时新建，隐藏预热不延长有效期。主窗口加载后约 1500 毫秒可以预热浮窗页面，但不创建模型请求。

## 快照与窗口状态

会话快照使用单调递增版本；presentation version 只对应会话/显示模式等窗口呈现变化。异步打开、新建、恢复、捕获通过 epoch 防止旧操作覆盖新状态。同一轮重复新建请求合并，避免创建多个空会话。

renderer 与主进程间的呈现探测有约 250 毫秒边界：新建时未知状态可重置，恢复时未知状态保留。布局提交先 flushSync，再经 requestAnimationFrame 加任务边界确认；不能把“多等两个动画帧”当作跨进程同步协议。

窗口采用 DIP 坐标，根据屏幕可用区域与 Dock 边界定位。紧凑和展开模式分别管理内容高度、附件区域和输入框上限，不让旧尺寸事件把新模式缩回去。

## 图片预算

单消息最多八张图，单源最多 10 MiB、4000 万像素，总源像素最多 8000 万。会话约 128 MiB 的保守预算同时计入解码处理、源数据/字符串和已发送历史；重试同一附件也需计算再次进入历史的成本。

重建会话清理所有临时资源。renderer 重载清理未发送附件、导入中的暂存和缓存，保留 host 中已经接受的历史。来源图标也绑定当前临时会话 scope，不能跨新建复用迟到结果。

## macOS 捕获和焦点

原生 quick-chat-focus.node 使用 AppKit 处理浮窗激活、前台应用记录与恢复；失败时回退 Electron 行为。用户主动隐藏才按约定恢复前台，程序内部切换不应把焦点抢回其他应用。

选区捕获 helper 模拟 Command+C 并在约一秒内检查剪贴板变化，截图/临时捕获文件按操作生命周期回收。权限不足或捕获失败保留可解释状态，不能假装拿到了选中文字。跨 Space 和 blur 事件会隐藏浮窗，需要与用户新打开请求做 epoch 协调。

## 源码与回归入口

- [Host](../../packages/desktop/src/main/quick-chat-host.ts)、[Window](../../packages/desktop/src/main/quick-chat-window.ts)、[呈现](../../packages/desktop/src/main/quick-chat-presentation.ts)、[附件](../../packages/desktop/src/main/quick-chat-attachments.ts)、[计时](../../packages/desktop/src/main/quick-chat-timing.ts)。
- [捕获](../../packages/desktop/src/main/mac-quick-chat-capture.ts)、[焦点](../../packages/desktop/src/main/mac-quick-chat-focus.ts)、[原生模块](../../packages/desktop/native/quick-chat-focus.m)、[renderer](../../packages/desktop/src/renderer/QuickChat.tsx)。
- [Host 测试](../../packages/desktop/test/quick-chat-host.test.ts)、[图片测试](../../packages/desktop/test/quick-chat-images.test.ts)、[时序测试](../../packages/desktop/test/quick-chat-timing.test.ts)、[窗口测试](../../packages/desktop/test/quick-chat-window.test.ts)。真实系统焦点测试需按[测试隔离](testing.md)单独运行。
