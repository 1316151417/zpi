# Electron 启动与进程边界

前置：[整体设计](../design.md)。开发启动命令见[开发向导](../features/development.md)。

## 入口和职责

main/index.ts 负责应用生命周期、窗口、单实例/存储初始化、服务装配和 IPC 注册。preload 暴露受控 bridge；renderer 通过 bridge 读取快照、订阅事件和请求操作。共享类型在 desktop/shared 中维护，UI 组件不直接操作 fs、凭据或子进程。

主窗口与快速对话有各自 preload、入口 HTML 和桥接能力。用户浏览器面板是独立 WebContentsView，不能获得主界面的 preload 权限。不要把预览页面当作受信任设置界面。

## 服务 owner

| 服务 | 持有状态 | 生命周期重点 |
| --- | --- | --- |
| SessionHost | 会话、run、能力、队列 | 事实先持久化，停止和关闭有明确边界 |
| StateStore/SettingsStore | 业务与设置/凭据 | 单写者锁、schema、generation |
| History Worker | JSONL 写入和索引 | durable ack、错误传播 |
| PaneServices | PTY 与浏览器视图 | owner 校验、显示边界、释放 |
| QuickChatHost/Window | 临时会话与浮窗 | 独立快照、超时、新建 epoch |
| 通知/快捷键服务 | 系统注册与焦点状态 | 注册回滚和窗口销毁清理 |

## IPC 校验与订阅

renderer 发出的 task ID、路径、请求 ID 和选项都需在主进程校验，不能因为 TypeScript 类型正确就信任运行时输入。文件预览、导出、编辑器打开、终端输入和任务操作各有授权范围和参数检查。

订阅返回清理函数，组件卸载时解除；异步响应核对当前 scope，避免旧任务结果覆盖新任务。快照带水位，随后只应用更新的增量事件。bridge 使用结构化可序列化数据，不跨进程传真实对象句柄。

## 启动与退出

开发模式加载本地 Vite，生产模式加载构建后的 renderer；入口选择由 load-renderer 集中处理。窗口加载不应自动触发模型请求。

退出先停止接收新工作，收尾会话/队列和持久化，释放 Worker、原生视图、PTY、快捷键与存储锁。renderer 崩溃可以重建视图，但不能因此复送已接受输入。捕获错误保存在本地日志，项目不包含遥测上传链路。

源码：[main](../../packages/desktop/src/main/index.ts)、[主 preload](../../packages/desktop/src/preload/index.ts)、[快速 preload](../../packages/desktop/src/preload/quick-chat.ts)、[bridge](../../packages/desktop/src/shared/bridge.ts)、[加载器](../../packages/desktop/src/main/load-renderer.ts)、[App](../../packages/desktop/src/renderer/App.tsx)。回归：[renderer 生命周期](../../packages/desktop/test/renderer-lifecycle-dom.test.ts)、[pane 隔离](../../packages/desktop/test/pane-isolation.test.ts)、[快速 preload](../../packages/desktop/test/quick-chat-preload.test.ts)。
