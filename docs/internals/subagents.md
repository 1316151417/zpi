# 子智能体的配置、协议与邮箱

使用入口：[协作](../features/collaboration.md)。辅助对话的用户交互入口见[会话](sessions.md)。

## 插件装配与运行时

系统内置 collaboration 插件向父会话注册 Agent、SendMessage，首次发送只保存已展示的名称、描述、来源路径和启用状态，后续注入文本复用该快照，不注册每轮 UserPromptSubmit 准备 Hook；输入候选和新启动独立查询当前配置与开关，不使用注入快照查找类型；子会话的 coordinator 插件注册 RespondToCoordinator。TaskOutput、TaskStop 由共享 TaskControls 装配，协作与后台命令分别注册后端。BuiltinPluginRuntime 持有协作调度与清理，宿主通过通用接口创建、运行和持久化子会话；core 不知道 Electron 或任务面板。父子共享 cwd，各自拥有模型请求、工具集合与历史。设置入口与生效范围见[插件](../features/plugins.md)。

内置 profile 为 general-purpose 和 Explore。配置加载器还处理用户/项目 profile、启用状态、工具范围、模型和指令。名称碰撞必须在加载阶段确定赢家或拒绝歧义，不能等工具执行时随机选择。父配置不保存未注入的角色正文、模型或工具权限；输入候选和显式 Agent 启动复用异步目录扫描及同名优先级处理，按名称解析当前启用状态、最新角色、模型与权限。同步扫描只用于同步设置和提示预览入口。新增或重命名立即可用，禁用、删除或无有效定义时拒绝启动；旧会话缺少注入目录也不影响当前查找。插件定义沿用已装配的插件配置。已启动子会话的角色、模型和权限属于它自己的执行配置；SendMessage 和冷恢复复用该配置及历史，不从父目录刷新或覆盖。最终工具 schema 通过声明传给模型，提示文字只说明协作规则，避免重复整个 schema。

## 委派与返回

协作插件选项 `promptPreset` 默认为 `default`，保留原始 ZPI（ZCode 风格）的 Agent 描述和内置类型说明；`codex` 改用适配 ZPI 能力的 Codex 提示，仅在用户或适用 AGENTS.md/skill 明确要求委派时启动，保留关键路径工作、后台并行、避免重复委派和按文件划分修改范围等指导。类型说明在 Codex 模式下只描述能力，用户自定义 profile 保留原文。子智能体工具参数、权限及调度实现不受此预设影响。

设置由 `plugins.options["zpi.collaboration"].promptPreset` 保存，随新对话首次发送进入插件快照；工具描述、模型可见类型列表和提示预览使用同一模式。关闭协作插件时预设置灰并保留选择。后台命令插件可以独立启停。

Agent 接收工作描述和 prompt，创建 child session、agent ID、任务 ID 与输出文件关联。同步完成返回结果正文、agentId、工具次数、耗时及已知 tokens；异步启动返回 async_launched 和任务定位信息。

SendMessage 定位本地可访问子任务。交付状态明确区分 queued、steered 和 resumed_background；消息送达不等于子任务已经回答。RespondToCoordinator 将回复排入父邮箱，返回后子任务仍继续原工作，除非协调者改变任务。

恢复或排队开始新一轮执行时，同步切换到独立的输出文件，保留上一轮文件供历史引用；SendMessage、任务快照和完成通知指向本轮路径。TaskOutput 等待超时不会停止子任务，可以返回本轮已有输出，但本轮尚无输出时不得回退到上一轮结果。

TaskOutput 与 TaskStop 的摘要按任务 ID 关联当前会话快照：子智能体显示任务描述，后台命令优先显示描述、缺失时显示命令；没有可用名称时显示原始 ID。完整 ID 保留在摘要悬浮提示中。名称仅用于展示，不改变工具参数、输出正文或任务状态。

父会话在完整工具批次或仅含思考、commentary、partial_answer 的模型响应成功结束后消费邮箱。不会在某个 reasoning/commentary item 结束时抢占连接。最终答复（含未标 phase 的正文）结束后不消费 queue-only 消息，期间收到的子任务结果保留到下次用户输入；父 run 已自然结束后收到的结果也不自动唤醒父任务。

## 输出预算

模型可见正文与完整输出文件分开。TaskOutput 默认截断到 32000 字符，可用 TASK_MAX_OUTPUT_LENGTH 调整，最大 160000；保留尾部并提供真实 outputFile 路径。没有真实文件时不能把 task ID 伪装成“完整输出路径”。

完成通知包含状态、摘要、结果、错误及用量，使用 XML 转义并限制长度。更大的工具结果经 artifacts 模块保存成文件和预览，避免把几百 KiB 输出直接扩散到所有父子上下文。UI 的任务详情与模型返回文本使用不同投影，不应互相反解析。

## 生命周期和失败

自然完成父 run 不要求所有后台子任务已经结束。主动停止会传递到所属子任务；关闭详情标签只关闭视图。恢复后需要保留完成、失败、中断之间的区别，不能把进程已丢失的任务继续显示成真实运行。

子智能体允许的工具名是配置边界，不是系统权限沙箱。只要允许 bash，就能运行 shell 能做的事。并行编辑同一文件应由协调者分工，文件工具内部队列只解决一次进程内的部分竞争。

## 源码与回归入口

- [runtime](../../packages/builtin-plugins/src/collaboration/runtime.ts)、[profiles](../../packages/builtin-plugins/src/collaboration/profiles.ts)、[协议](../../packages/builtin-plugins/src/collaboration/protocol.ts)、[大输出](../../packages/builtin-plugins/src/collaboration/artifacts.ts)、[提示](../../packages/builtin-plugins/src/collaboration/prompts.ts)。
- [协作测试](../../packages/desktop/test/subagents.test.ts)、[协议测试](../../packages/builtin-plugins/test/subagent-protocol.test.ts)、[profile 碰撞](../../packages/desktop/test/subagent-profile-collision.test.ts)、[提示测试](../../packages/desktop/test/subagent-prompts.test.ts)。
