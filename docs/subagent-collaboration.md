# 主子智能体协作

本次核对的本地参考版本：Codex `2839ed763bd3f404398e1f0c95bf4e2d172213c0`，ZCode `3c5b227649371507ddc4eb46ac5133afe6db1cab`。测试固定保存 ZCode 的原始文案，不在测试时读取开发者机器上的参考仓库。

Codex 的 `agent/control/completion.rs` 用 `trigger_turn=false` 投递完成消息。`session/turn_input.rs` 把入队和空闲唤醒分开，`features/src/lib.rs` 中 `wake_on_agent_messages` 默认关闭；`scenarios.rs` 的完成后唤醒场景显式启用了该开关。`session/turn.rs` 默认在完整 reasoning、commentary、partial_answer 输出项后检查邮箱，提前结束采样并继续本轮，final_answer 不触发切换。它也提供默认关闭的 `defer_mailbox_preemption`，把邮件延后到正常请求边界；Responses Lite 路径支持协议级中断并接收终态，保留连接和 response ID。`scenarios_mailbox_preemption_tests.rs` 覆盖延后消费、增量续接及断连恢复。

ZPI 的 `SessionHost` 持久保存收件箱；运行中的 SDK 通过通用 `steer(text, { queueOnly: true })` 接收消息。核心 `getPendingMessages` 只在请求开始，或当前模型响应及其工具批次成功完成后消费消息。思考、commentary 和正文片段结束都不取消生成，避免关闭 WebSocket、丢失 response ID 并全量重发上下文。工具仍由原协调器完成并写入一次结果。纯文本响应（包括 final_answer）结束时，已排队的消息也会接入同一运行的下一次请求；不会因没有工具调用而滞留。停止、失败和输出截断时不消费待处理消息。消息落入会话记录后才确认收件箱消费；恢复时根据内部 inputId 去重（兼容旧版文本标记）。没有增加等待所有子任务的结束屏障；父会话已结束后才收到的结果仍留待下次用户输入。

Responses 的 summary/text done 只是子片段结束，输出项还可能补充 phase、完整正文或 reasoning 签名。因此等到 output_item.done 再发送结束事件，但消息投递还要等整个响应及工具批次完成。普通 `steer(text)` 和 queue-only 都不会打断当前生成；子结果及协调器回复继续使用 queue-only 入口，由桌面收件箱负责未消费消息的持久化。用户停止仍会停止所属子任务；这与自然结束后保留后台子任务是两个行为。

## ZCode 对齐范围与必要差异

| 项目 | 对齐与差异 | 原因 |
| --- | --- | --- |
| Agent | 保留完整 provider 描述，包括“委派搜索后等待结果”；缺省 general-purpose、前台运行。取消原有额外字符串长度限制。产品路径 `.zcode/agents` 替换为 `.zpi/agents`，不包含 CreateWorkflow 条款 | ZPI 无工作流工具；对应 ZCode `dynamicWorkflowEnabled=false` 分支 |
| 工具描述注入 | 完整 description 仅由模型请求的 tools 字段承载；系统提示词只保留 read、write、edit、bash 的 promptSnippet，不回退 description，不注入扩展工具的 promptSnippet；保留 promptGuidelines 行为规则 | 扩展工具对齐 ZCode，避免重复强调 Agent 的委派指导；保留四个内置工具的简短说明 |
| Agent 返回 | 前台最终正文、空结果占位、继续 agent 的说明、可选 token usage，以及后台有/无 Read/Bash 两个分支完整对齐 | 返回真实 output_file；不再省略文件路径、禁止读取说明或结束回复分支 |
| SendMessage | 使用 runner 实际生成的 queued、steered、resumed_background 原文；不再使用 formatter 的兜底模板。失败保留 status/messageId/agentId/error/message；终态恢复使用 message 正文为新 prompt，summary 更新任务描述 | 活跃指导保留 summary、正文及 coordinator_steer 包装；内部运行仍复用桌面会话 |
| RespondToCoordinator | 完整描述和六条 Usage 指令；成功/失败的 continuation、responseId、结构化结果和发给主 agent 的完整 XML 一致。业务失败保留有效工具返回，不标记为执行异常 | 父消息投递成功即返回 queued，是否继续模型请求由收件箱决定 |
| TaskOutput | 完整原始描述（含 DEPRECATED、Read、remote_agent、/tasks）、参数/default/required、字符串布尔兼容、状态与 XML 对齐。优先完成结果、回退真实文件，读文件尾部最多 8 MiB；支持长度配置及大结果落盘 | 原始描述的 `.output` 转录 symlink 说法与当前 ZCode runner 已不一致；按要求保留原文，实际两端均写 output.txt/task.output 纯结果 |
| TaskStop | 完整描述、task_id/shell_id、缺参/查找失败/非运行状态、成功 JSON 与状态 killed 对齐；停止结果写文件并发送 stopped 通知 | 原有统一任务工具仍路由本地 agent 和后台命令；保持会话所有权限制 |
| 后台通知与父消息 | task-id/tool-use-id/output-file/status/summary/result/error/usage、XML 转义和 120000 字符上限对齐；保留 incoming-message 的来源说明和 system-reminder 包装 | ZCode 产品名换为 ZPI；同轮消息和后续用户轮使用各自的原始提示分支 |
| 长返回与文件 | Agent 120000 字节、SendMessage/RespondToCoordinator 4096 字节、TaskOutput 400000 字节及 100000 字符落盘阈值、TaskStop 100000 字节；原始 preview/截断说明和完整结果落盘 | 文件放在 ZPI 数据目录 agent/subagents 下，工具结果文件以调用 ID 哈希命名；不引入 ZCode artifact/trace 服务 |
| 内置子 agent | general-purpose、Explore 的正文及通用 Notes 恢复完整原文和示例；仅替换产品名及真实工具名 `Read`→`read`、`Bash`→`bash`、`Write`→`write` | SDK 四个内置工具使用小写名称。Explore 使用 ZCode embedded-search 分支的 find/grep 指导，不添加 Glob/Grep 工具 |
| 工具能力 | Explore 保留 ZPI 当前只读工具白名单及允许的桌面任务/联网能力；不照搬 ToolSearch、DeferredToolCall、TodoWrite、MCP 等工具 | 保持 ZPI 架构与已有能力；没有为提示词对齐扩展其他功能 |
| agent 列表 | 保留列表标题、名称/描述/Tools 格式及完整并行说明，用 system-reminder 包裹；随现有系统 section 刷新，不另加增删 attachment 历史 | ZPI 由首次运行准备的配置快照和系统 section 管理模型上下文；不引入 ZCode 的 attachment/delta 机制 |
| 兼容别名 | 不新增隐藏的 Task、AgentOutputTool、BashOutputTool、KillShell 等工具别名；保留 TaskStop 的 shell_id 参数 | ZPI 没有 ZCode 的工具别名/延迟发现注册表，本次不新增工具入口 |
| 系统上下文 | 保留 ZPI 的环境/日期/模型、AGENTS、技能和继承记忆注入路径，以及子任务不维护共享记忆的既有规则 | 这些能力各有现成状态所有者；未照搬 CLI prefix、MCP、工作流或记忆服务 |
| 错误与 UI | 对齐协作工具的参数校验、业务失败及执行失败文案；不移植 ZCode 的错误类、trace、权限框架或 UI 事件格式 | SDK 仍以 content/details/isError 返回结果；UI 原状态 error/aborted/interrupted 在模型边界映射为 failed/killed。桌面会话关闭、归档、存储和模型不可用等本地异常仍由已有服务负责 |
| 迟到结果 | 子 agent 及协调器回复始终 queue-only，不增加自动唤醒开关 | 按本次要求以 Codex 默认行为为准；不照搬 ZCode 的空闲唤醒。后台命令原有策略保留 |

正在用户停止或应用关闭时，SendMessage 返回原始 aborted 失败文案，不允许排队恢复子任务；保持本次要求的停止边界。ZPI 不引入 ZCode CLI 的会话就绪门、轮询注册表、命令队列或跨会话权限服务；继续复用既有 SDK、桌面运行与取消所有者。

ZCode `context/dynamic-sections.ts` 中额外 Agent 指导段已注释，不会发给模型，本次也没有复活这些规则。`RespondToCoordinator` 的 modelInstructions 则确实由 registry 合入 provider 工具描述，必须保留。

验证覆盖响应完成后批量消费、保留/排空已开始的工具、纯文本结束后续轮、WebSocket 与 response ID 复用、迟到结果及重启恢复、手动压缩、用户停止和 provider 异常。工具文案测试核对实际模型请求中的描述、子 agent 系统提示词、Notes 和列表说明，而非只检查模板常量。

返回值测试夹具通过实际执行当前 ZCode 的 formatter、runner 成功结果构造器、incoming-message 投影及 contracts schema 转换获得；覆盖正常、空白、失败、停止、转义、截断、usage 缺失和零值。运行层测试另行调用真实工具，确认不是只有模板字符串一致。


本次实际验证（2026-10-25）：`npm run check` 通过（保留原有 4 个 CSS warning、6 个 info）；完整 `npm run test:unit` 为 3938 通过、1 跳过、1 失败，唯一失败为已有 `side-chat-opening.test.ts` 的 SSR portal 容器问题；协作相关用例均通过。`npm run test:desktop -- tests/desktop/subagents.spec.ts` 通过 4 个隔离 Electron 用例。`git diff --check` 通过。
