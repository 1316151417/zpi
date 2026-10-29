# SDK 装配与扩展边界

使用入口和可运行代码：[SDK 向导](../features/sdk.md)。

## createAgentSession 的装配顺序

先校验选项，确定 cwd、agentDir、SessionManager 与 SettingsManager，物化需要恢复的上下文。cwd 优先取显式参数，再取 sessionManager 的工作目录，最后才是 process.cwd；默认 agentDir 为 `~/.zpi/agent`。

模型优先使用显式选择，再尝试会话记录，最后从运行时可用模型中选择。模型切换写入历史，未配置凭据不能用 UI 名称绕过。恢复时还检查工具 journal，补齐已知的中断状态。

接着构造四个内置工具与共享 FileReadState，合并 overrides/customTools，加载资源和提示，选择推理级别，最后创建 AgentSession。已有会话优先恢复有效推理选择；不支持的级别按模型能力夹取。

## 工具扩展约束

`customTools` 增加新名称，不能与已有工具重名；`toolOverrides` 只允许覆盖已知内置工具。`noTools` 控制默认工具集合，显式 tools 列表选择具体工具，excludeTools 校验后排除。不要新增一个看起来像内置工具的隐藏别名来绕过选择规则。

ToolContext 提供 cwd、model、thinkingLevel、sessionManager、signal、isIdle、当前系统提示与工具名查询。metadata 声明只读、并发、副作用和交互属性，影响[流式执行资格](agent-loop.md)。outputSchema 属于结果描述元数据，不能替代 execute 中的结果验证。

桌面把提问和子智能体放入 customTools，把持久后台 bash 放入 toolOverrides。核心只提供这些通用接口，不 import Electron、不读取窗口状态，也不依赖桌面 IPC。

## 存储和生命周期

SessionManager 可持久化、恢复或仅在内存中工作；内存模式只是不写会话日志，文件和 bash 工具仍有副作用。扩展函数不会被序列化到日志，恢复时需重新提供实现。

设置由用户级 settings.json 和项目 `.zpi/settings.json` 合并，支持注入内存 SettingsManager。读取坏设置会记录错误；不能静默把用户设置视为成功保存。资源加载器和 customInstructions 是不同层，详见[资源](resources.md)。

订阅事件用于展示和持久化协调。异步事件 sink 失败可能阻止后续执行，不能把它当作无关紧要的打印回调。退出前 abort 当前 run，再 dispose 释放订阅和 Responses 连接；宿主自己创建的外部服务还需由宿主关闭。

## 验证入口

- [SDK 入口](../../packages/coding-agent/src/core/sdk.ts)、[类型](../../packages/coding-agent/src/core/types.ts)、[会话对象](../../packages/coding-agent/src/core/agent-session.ts)、[示例](../../examples/coding-session.ts)。
- [override 测试](../../packages/coding-agent/test/tool-overrides.test.ts)、[运行时测试](../../packages/coding-agent/test/model-runtime.test.ts)、[设置测试](../../packages/coding-agent/test/settings-manager.test.ts)、[会话测试](../../packages/coding-agent/test/session.test.ts)。
