# 后台命令与交互终端

使用入口：[后台命令和终端](../features/background-terminal.md)。这两个功能共享工作目录，但使用不同进程与展示协议。

## 桌面 bash 覆盖

桌面 bash 的 timeout 单位是毫秒，默认 120000、最大默认 600000，可由 BASH_DEFAULT_TIMEOUT_MS/BASH_MAX_TIMEOUT_MS 调整。与 SDK bash 的秒单位不同。`run_in_background` 立即后台化；普通前台命令到时可转后台，单纯 sleep 命令到时则终止。

每次命令创建 exec_ ID 和独占输出文件，主进程维护执行句柄、状态、等待者与输出位置。后台化解除当前前台等待，进程可以跨模型 turn 存活。它不表示进程能够跨应用重启恢复。

输出持续写盘，前台展示有界预览，主进程每秒检查输出大小；默认 5 GiB 是定期检查的软上限，不是精确到字节的硬配额。子智能体所属后台命令还有时长保护。完整输出与给模型/界面的尾部是分开的。

## 读取与停止

TaskOutput 校验 task 所有权，可立即返回或阻塞等待，默认等待 30 秒，schema 限制最大等待。读取文件有独立的有界尾部读取，再按字符预算格式化。UI 快照只取最多 64 KiB 尾部，避免不断传送整个日志。

TaskStop 显式停止目标。停止前台 run 与停止已经后台化的命令要分清；后台任务完成自动发布通知，不需要模型不停轮询。应用退出、任务清理和恢复对丢失进程句柄各有收尾路径，不能把历史 running 字段当成进程仍存活的证据。

## 交互终端

终端由 PaneServices 持有 node-pty，renderer 的 TerminalPane 负责 xterm 显示、尺寸和键盘输入。切换标签保留 PTY，关闭终端或销毁所属视图时释放。不要通过重新挂载组件反复创建 shell。

Windows 使用 ComSpec/cmd；类 Unix 使用 SHELL 或 zsh/sh，并以登录 shell 参数启动。macOS 终端 profile 读取有缓存，影响初始样式；它不是模型指令。终端尺寸由实际可见面板传回，隐藏面板避免发送无效的零尺寸。

输出订阅和窗口/任务身份绑定，迟到数据不能写入另一个任务的终端。用户手动输入的命令不会自动成为 Agent 工具调用或上下文。

## 源码与回归入口

- [后台任务](../../packages/desktop/src/main/background-tasks.ts)、[任务进程](../../packages/desktop/src/main/task-processes.ts)、[面板服务](../../packages/desktop/src/main/pane-services.ts)、[shell](../../packages/desktop/src/main/terminal-shell.ts)、[profile](../../packages/desktop/src/main/terminal-profile.ts)。
- [后台任务测试](../../packages/desktop/test/background-tasks.test.ts)、[终端服务测试](../../packages/desktop/test/terminal-services.test.ts)、[终端 shell 测试](../../packages/desktop/test/terminal-shell.test.ts)、[进程展示](../../packages/ui/test/process-presentation.test.ts)。
