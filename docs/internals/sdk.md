# SDK 装配与扩展边界

使用入口和可运行代码：[SDK 向导](../features/sdk.md)。

## 公开 SDK 与原生宿主

`packages/agent-sdk` 提供 Claude 风格的 `query`、Options、消息与控制协议。协议适配、标准工具参数、策略、资源发现和打包均在此包实现；底层循环不感知这些兼容名称。构建产物包含私有运行时及独立声明文件，不依赖桌面包。

桌面从 `zpi-agent-sdk/host` 创建原生会话，用 `query` 驱动主会话、标题生成与记忆处理。主会话通过 `zpi.session/sessionManager/modelRuntime/input` 复用已冻结的插件装配、索引存储和已解析输入。SDK 不接管该会话的销毁；原生事件继续用于桌面投影。借用会话时不能传 `canUseTool` 等创建期工具策略，应在原生会话创建阶段统一配置。普通脚本直接使用 `query`，由 SDK 持有并释放会话。

内核通过完整系统提示、模型请求前检查、动态请求选项、压缩前后事件和资源加载后的工具准备端口与宿主协作，均与外部协议解耦。

## createAgentSession 的装配顺序

先校验选项，确定 cwd、agentDir、SessionManager 与 SettingsManager，物化需要恢复的上下文。cwd 优先取显式参数，再取 sessionManager 的工作目录，最后才是 process.cwd；默认 agentDir 为 `~/.zpi/agent`。

模型优先使用显式选择，再尝试会话记录，最后从运行时可用模型中选择。模型切换写入历史，未配置凭据不能用 UI 名称绕过。恢复时还检查工具 journal，补齐已知的中断状态。

接着构造四个内置工具与共享 FileReadState，创建并加载唯一的资源目录。`prepareTools(loader)` 可以按已加载的技能目录返回 customTools 和 tools；由 `assembleSession` 统一合并插件、overrides/customTools、命令和指令，再构造提示、选择推理级别并创建 AgentSession。资源后续刷新仍使用同一加载器，初始化不重复包装和扫描插件技能。完整 `systemPrompt` 回调接收最终启用工具、经过校验的插件指令和最终资源加载器，公开 SDK 不再重新遍历插件拼提示。桌面提示预览和工具列表也走同一装配入口。已有会话优先恢复有效推理选择；不支持的级别按模型能力夹取。

## 工具扩展约束

`customTools` 增加新名称，不能与已有工具重名；`toolOverrides` 只允许覆盖已知内置工具。`noTools` 控制默认工具集合，显式 tools 列表选择具体工具，excludeTools 校验后排除。不要新增一个看起来像内置工具的隐藏别名来绕过选择规则。

ToolContext 提供 cwd、model、thinkingLevel、sessionManager、signal、isIdle、当前系统提示与工具名查询。metadata 声明只读、并发、副作用和交互属性，影响[流式执行资格](agent-loop.md)。outputSchema 属于结果描述元数据，不能替代 execute 中的结果验证。

桌面把提问和子智能体放入 customTools，把持久后台 bash 放入 toolOverrides。核心只提供这些通用接口，不 import Electron、不读取窗口状态，也不依赖桌面 IPC。

## 存储和生命周期

SDK 与桌面共用核心的文件回退预检和提交引擎：校验完整修改链、原子替换，提交失败时回滚；桌面在薄适配层额外约束工作区与快照归属。Markdown frontmatter 的语法解析也在核心共享，技能、插件与 Agent 各自保留字段规则。

SessionManager 可持久化、恢复或仅在内存中工作；内存模式只是不写会话日志，文件和 bash 工具仍有副作用。扩展函数不会被序列化到日志，恢复时需重新提供实现。

设置由用户级 settings.json 和项目 `.zpi/settings.json` 合并，支持注入内存 SettingsManager。读取坏设置会记录错误；不能静默把用户设置视为成功保存。资源加载器和 customInstructions 是不同层，详见[资源](resources.md)。

订阅事件用于展示和持久化协调。异步事件 sink 失败可能阻止后续执行，不能把它当作无关紧要的打印回调。退出前 abort 当前 run，再 dispose 释放订阅和 Responses 连接；宿主自己创建的外部服务还需由宿主关闭。

`plugins` 与 `hooks` 是原生注入入口。HookRunner 校验输出并控制预算、超时和错误策略；SessionHooks 把结果转换为独立的 synthetic 上下文消息，交给循环持久化。Stop 反馈形成真实下一轮输入，不修改最终回答。工具 hook 存在时关闭流式提前执行。事件、迁移和冻结规则见[插件契约](plugins.md)。

## 验证入口

- [SDK 入口](../../packages/coding-agent/src/core/sdk.ts)、[类型](../../packages/coding-agent/src/core/types.ts)、[会话对象](../../packages/coding-agent/src/core/agent-session.ts)、[示例](../../examples/coding-session.ts)。
- [override 测试](../../packages/coding-agent/test/tool-overrides.test.ts)、[运行时测试](../../packages/coding-agent/test/model-runtime.test.ts)、[设置测试](../../packages/coding-agent/test/settings-manager.test.ts)、[会话测试](../../packages/coding-agent/test/session.test.ts)。
