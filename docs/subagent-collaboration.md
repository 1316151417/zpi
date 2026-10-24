# 主子智能体协作

本次核对的本地参考版本：Codex `2839ed763bd3f404398e1f0c95bf4e2d172213c0`，ZCode `3c5b227649371507ddc4eb46ac5133afe6db1cab`。测试固定保存 ZCode 的原始文案，不在测试时读取开发者机器上的参考仓库。

Codex 的 `agent/control/completion.rs` 用 `trigger_turn=false` 投递完成消息。`session/turn_input.rs` 把入队和空闲唤醒分开，`features/src/lib.rs` 中 `wake_on_agent_messages` 默认关闭；`scenarios.rs` 的完成后唤醒场景显式启用了该开关。`session/input_queue.rs` 在最终答复后推迟 queue-only 邮件，工具调用则重新接受本轮邮件。`session/turn.rs` 在完整 reasoning、commentary、partial_answer 输出项后检查邮箱，提前结束采样并继续本轮，final_answer 不触发切换。`scenarios_mailbox_preemption_tests.rs` 同时覆盖这些边界以及流断开、保留已完成调用等情况。

ZPI 的 `SessionHost` 持久保存收件箱；运行中的 SDK 通过通用 `steer(text, { queueOnly: true })` 接收消息。核心 `getPendingMessages` 只在请求开始、完整思考/中间回复结束或工具批次结束时消费消息。提前切换只取消当前模型请求，工具仍由原协调器完成并写入一次结果。最终答复后不读取 queue-only 输入；下次用户输入时先送入模型。消息落入会话记录后才确认收件箱消费；恢复时根据唯一通知标记去重。没有增加等待所有子任务的结束屏障。

Responses 的 summary/text done 只是子片段结束，输出项还可能补充 phase、完整正文或 reasoning 签名。因此等到 output_item.done 再发送结束事件。没有 phase 的正文按最终答复处理，避免把普通答复误当中间回复。普通 `steer(text)` 的显式指导仍允许结束后的续轮；只有子结果及协调器回复使用 queue-only。用户停止仍会停止所属子任务；这与自然结束后保留后台子任务是两个行为。

## ZCode 对齐范围与必要差异

| 项目 | 对齐与差异 | 原因 |
| --- | --- | --- |
| Agent | 保留完整 provider 描述，包括“委派搜索后等待结果”；缺省 general-purpose、前台运行。取消原有额外字符串长度限制。产品路径 `.zcode/agents` 替换为 `.zpi/agents`，不包含 CreateWorkflow 条款 | ZPI 无工作流工具；对应 ZCode `dynamicWorkflowEnabled=false` 分支 |
| Agent 返回 | 前台结果、继续 agent 的说明与 usage 原文一致；后台使用原文启动说明、内部 ID 提示和不重复工作段落。省略 output_file 及禁止读取该文件的句子，不采用“无读取工具时必须结束回复”分支 | ZPI 未向父模型提供 ZCode 的 `.output` 会话转录链接；子会话 ID、完整历史在桌面任务面板维护。不伪造文件路径，也不新增转录导出能力 |
| SendMessage | 完整描述、参数说明和 queued/steered/resumed_background 返回文案一致 | 继续使用 ZPI 的会话所有权、取消和排队实现 |
| RespondToCoordinator | 保留原始描述和全部六条 modelInstructions，按 ZCode registry 实际方式拼成 `Usage:`；成功和失败均带完整 continuation 原文 | ZPI 工具通过 content/isError 返回结果；不用 ZCode 的 port/registry 输出封装 |
| TaskOutput | task_id/block/timeout 参数、provider required、默认 true/30000、0–600000 ms、字符串布尔兼容与结果 XML 格式一致。保留适用的使用条款；不标 DEPRECATED，不承诺 output 文件通知、remote_agent 或 `/tasks` | ZPI 仍依赖该工具查看/等待本地任务，没有远程会话或 `/tasks` 命令；本地 agent 返回最终结果，不返回完整会话转录。命令仍可通过原有日志入口查看 |
| TaskStop | 完整描述、可选 task_id/shell_id、缺参/查找失败/非运行状态说明、成功 JSON 文案一致 | 原有统一任务工具仍路由本地 agent 和后台命令；保持会话所有权限制 |
| 内置子 agent | general-purpose、Explore 的正文及通用 Notes 恢复完整原文和示例；仅替换产品名及真实工具名 `Read`→`read`、`Bash`→`bash`、`Write`→`write` | SDK 四个内置工具使用小写名称。Explore 使用 ZCode embedded-search 分支的 find/grep 指导，不添加 Glob/Grep 工具 |
| 工具能力 | Explore 保留 ZPI 当前只读工具白名单及允许的桌面任务/联网能力；不照搬 ToolSearch、DeferredToolCall、TodoWrite、MCP 等工具 | 保持 ZPI 架构与已有能力；没有为提示词对齐扩展其他功能 |
| agent 列表 | 保留列表标题、名称/描述/Tools 格式及完整并行说明，用 system-reminder 包裹；随现有系统 section 刷新，不另加增删 attachment 历史 | ZPI 由首次运行准备的配置快照和系统 section 管理模型上下文；不引入 ZCode 的 attachment/delta 机制 |
| 兼容别名 | 不新增隐藏的 Task、AgentOutputTool、BashOutputTool、KillShell 等工具别名；保留 TaskStop 的 shell_id 参数 | ZPI 没有 ZCode 的工具别名/延迟发现注册表，本次不新增工具入口 |
| 系统上下文 | 保留 ZPI 的环境/日期/模型、AGENTS、技能和继承记忆注入路径，以及子任务不维护共享记忆的既有规则 | 这些能力各有现成状态所有者；未照搬 CLI prefix、MCP、工作流或记忆服务 |
| 错误与 UI | 不移植 ZCode 的错误码、trace、权限、artifact budget 和 provider outputSchema 框架；模型仍接收 ZPI 的工具 content/isError，界面保留原标签与任务记录 | 仅对齐模型可见契约和文案，复用已有 SDK 与桌面服务 |
| 迟到结果 | 子 agent 及协调器回复始终 queue-only，不增加自动唤醒开关 | 按本次要求以 Codex 默认行为为准；不照搬 ZCode 的空闲唤醒。后台命令原有策略保留 |

ZCode `context/dynamic-sections.ts` 中额外 Agent 指导段已注释，不会发给模型，本次也没有复活这些规则。`RespondToCoordinator` 的 modelInstructions 则确实由 registry 合入 provider 工具描述，必须保留。

验证覆盖同轮提前消费、保留/排空已开始的工具、最终答复不补充、迟到结果及重启恢复、手动压缩、用户停止和 provider 异常。工具文案测试核对实际模型请求中的描述、子 agent 系统提示词、Notes 和列表说明，而非只检查模板常量。
