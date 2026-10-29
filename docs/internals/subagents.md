# 子智能体的配置、协议与邮箱

使用入口：[协作](../features/collaboration.md)。辅助对话的用户交互入口见[会话](sessions.md)。

## 扩展而非核心分支

桌面插件创建独立 SDK 会话，向父会话注册 Agent、SendMessage、RespondToCoordinator、TaskOutput、TaskStop。core 不知道 Electron 或任务面板；父子共享 cwd，各自拥有模型请求、工具集合与历史。

内置 profile 为 general-purpose 和 Explore。配置加载器还处理用户/项目 profile、启用状态、工具范围、模型和指令。名称碰撞必须在加载阶段确定赢家或拒绝歧义，不能等工具执行时随机选择。最终工具 schema 通过声明传给模型，提示文字只说明协作规则，避免重复整个 schema。

## 委派与返回

Agent 接收工作描述和 prompt，创建 child session、agent ID、任务 ID 与输出文件关联。同步完成返回结果正文、agentId、工具次数、耗时及已知 tokens；异步启动返回 async_launched 和任务定位信息。

SendMessage 定位本地可访问子任务。交付状态明确区分 queued、steered 和 resumed_background；消息送达不等于子任务已经回答。RespondToCoordinator 将回复排入父邮箱，返回后子任务仍继续原工作，除非协调者改变任务。

父会话在一个完整模型响应及工具批次结束后消费邮箱，文本回答也检查邮箱。不会在某个 reasoning/commentary item 结束时抢占连接。父 run 已自然结束后才收到的结果等待后续用户输入，不自动唤醒父任务。

## 输出预算

模型可见正文与完整输出文件分开。TaskOutput 默认截断到 32000 字符，可用 TASK_MAX_OUTPUT_LENGTH 调整，最大 160000；保留尾部并提供真实 outputFile 路径。没有真实文件时不能把 task ID 伪装成“完整输出路径”。

完成通知包含状态、摘要、结果、错误及用量，使用 XML 转义并限制长度。更大的工具结果经 artifacts 模块保存成文件和预览，避免把几百 KiB 输出直接扩散到所有父子上下文。UI 的任务详情与模型返回文本使用不同投影，不应互相反解析。

## 生命周期和失败

自然完成父 run 不要求所有后台子任务已经结束。主动停止会传递到所属子任务；关闭详情标签只关闭视图。恢复后需要保留完成、失败、中断之间的区别，不能把进程已丢失的任务继续显示成真实运行。

子智能体允许的工具名是配置边界，不是系统权限沙箱。只要允许 bash，就能运行 shell 能做的事。并行编辑同一文件应由协调者分工，文件工具内部队列只解决一次进程内的部分竞争。

## 源码与回归入口

- [runtime](../../packages/desktop/src/main/plugins/subagents/runtime.ts)、[profiles](../../packages/desktop/src/main/plugins/subagents/profiles.ts)、[协议](../../packages/desktop/src/main/plugins/subagents/protocol.ts)、[大输出](../../packages/desktop/src/main/plugins/subagents/artifacts.ts)、[提示](../../packages/desktop/src/main/plugins/subagents/prompts.ts)。
- [协作测试](../../packages/desktop/test/subagents.test.ts)、[协议测试](../../packages/desktop/test/subagent-protocol.test.ts)、[profile 碰撞](../../packages/desktop/test/subagent-profile-collision.test.ts)、[提示测试](../../packages/desktop/test/subagent-prompts.test.ts)。
