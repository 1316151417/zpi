# 会话、任务与运行生命周期

使用入口：[对话操作](../features/conversations.md)。底层执行见[Agent 循环](agent-loop.md)，持久化见[历史](history.md)。

## 三个层级

任务保存标题、项目、目录、归档等业务属性；会话保存可恢复的对话和模型状态；run 对应一次已接受的输入所驱动的执行。一个 run 可以产生多个模型请求和工具批次。不能把“最后一个模型请求结束”直接等同于“任务删除”或“全部后台任务停止”。

`SessionHost` 是桌面的装配和协调者，持有活动会话、输入队列、插件快照及事件订阅，维护会话读写与删除的事务次序。`BuiltinPluginRuntime` 持有七类内置插件服务的策略、调度、恢复与清理；宿主只向其提供模型、存储、历史和平台接口。`AgentSession` 负责核心上下文、模型调用、压缩、恢复和工具 journal；`SessionManager` 组织日志和分支状态。

## 首次发送

未发送的草稿可以调整目录、模型与插件。首次接受输入时冻结启用插件的版本、选项、指令、命令与运行时，按快照绑定插件工具和 Hook，经统一装配入口创建会话，再由共享 Agent SDK 的 `query` 驱动。之后修改全局默认只影响相应的新会话；服务凭据有效性与系统通知投递偏好仍在调用边界检查。用户可见规则见[插件生效范围](../features/plugins.md#生效范围)。

先写入可恢复的用户输入和运行事实，再发布会话变化、开始模型调用。session-title 插件通过 InputAccepted / RunStart 提供临时标题和独立辅助请求，TitlePolicy 持有取消与收尾；不混入主模型的计量与上下文。异步结果要核对会话存在状态和手动命名状态，不能回填到已删除或手动命名的会话。notifications 插件在结算完成后的 Notification hook 调用系统通知端口，通知失败不能阻断结算。

## 停止与自然结束

自然结束保留已完成事实和独立后台任务。主动停止传播取消到当前请求、前台工具和所属协作任务，但不能撤销已经成功的文件写入。后台命令有独立的结束/停止协议，详见[进程生命周期](background-terminal.md)。

renderer 卸载、切换任务、关闭详情页与停止 run 不是同一事件。活动状态属于主进程；窗口重建应从快照与增量序号恢复显示，而不是再次发送用户输入。

## 辅助对话与分叉

辅助对话从父任务已经稳定保存的上下文建立新会话，运行中的未完成助手片段不复制。继承的前缀参与模型上下文，UI 只显示它自己的新时间线。辅助会话有独立模型、队列和运行状态，共享父任务 cwd。

普通分叉也需要重新映射日志标识和复制受控附件，不能让子会话依赖父任务之后可能清理的附件目录。编辑历史输入会重建后续有效分支；文件回退由独立快照与冲突检查完成，不靠截断 transcript 猜测文件状态。

## 归档、删除和恢复

归档是可恢复的业务状态，运行中的任务先停止。删除写入 tombstone 和待清理记录，不能让迟到的 upsert 将任务复活；历史文件清理可在下一次启动重试。工作目录属于用户项目，任务删除不递归删除整个 cwd。

恢复先检查会话格式和执行 journal，加载必要上下文；旧队列保持暂停。损坏历史需要显示明确错误，不能用空会话覆盖原始文件。存储 generation 的切换和回滚见[业务存储](storage.md)。

## 源码与回归入口

- [宿主](../../packages/desktop/src/main/session-host.ts)、[任务状态](../../packages/desktop/src/main/task-state.ts)、[核心会话](../../packages/coding-agent/src/core/agent-session.ts)、[SessionManager](../../packages/coding-agent/src/core/session-manager.ts)。
- [能力测试](../../packages/desktop/test/session-capabilities.test.ts)、[辅助对话](../../packages/desktop/test/side-chat.test.ts)、[辅助恢复](../../packages/desktop/test/side-chat-recovery.test.ts)、[工作流恢复](../../packages/desktop/test/task-workflow-recovery.test.ts)、[消息操作](../../packages/desktop/test/message-actions.test.ts)。
