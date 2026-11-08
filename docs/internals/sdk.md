# SDK 装配与扩展边界

使用入口和可运行代码：[SDK 向导](../features/sdk.md)。

## 公开 SDK 与原生宿主

`packages/agent-sdk` 提供 Claude 风格的 `query`、Options、消息与控制协议。协议适配、标准工具参数、策略、资源发现和打包均在此包实现；底层循环不感知这些兼容名称。构建产物包含私有运行时及独立声明文件，不依赖桌面包。

桌面从 `@zpi-dev/agent-sdk/host` 创建原生会话，用 `query` 驱动主会话、标题生成与记忆处理。主会话通过 `zpi.session/sessionManager/modelRuntime/input` 复用已冻结的插件装配、索引存储和已解析输入。SDK 不接管该会话的销毁；原生事件继续用于桌面投影。借用会话时不能传 `canUseTool` 等创建期工具策略，应在原生会话创建阶段统一配置。普通脚本直接使用 `query`，由 SDK 持有并释放会话。

内核通过完整系统提示、模型请求前检查、动态请求选项、压缩前后事件和资源加载后的工具准备端口与宿主协作，均与外部协议解耦。

## createAgentSession 的装配顺序

先校验选项，确定 cwd、agentDir、SessionManager 与 SettingsManager，物化需要恢复的上下文。cwd 优先取显式参数，再取 sessionManager 的工作目录，最后才是 process.cwd；默认 agentDir 为 `~/.zpi/agent`。

模型优先使用显式选择，再尝试会话记录，最后从运行时可用模型中选择。模型切换写入历史，未配置凭据不能用 UI 名称绕过。恢复时还检查工具 journal，补齐已知的中断状态。

接着构造四个内置工具与共享 FileReadState，创建并加载唯一的资源目录。`prepareTools(loader)` 可以按已加载的技能目录返回 customTools 和 tools；由 `assembleSession` 统一合并插件、overrides/customTools、命令和指令，再构造提示、选择推理级别并创建 AgentSession。资源后续刷新仍使用同一加载器，初始化不重复包装和扫描插件技能。完整 `systemPrompt` 回调接收最终启用工具、经过校验的插件指令和最终资源加载器，公开 SDK 不再重新遍历插件拼提示。桌面提示预览和工具列表也走同一装配入口。已有会话优先恢复有效推理选择；不支持的级别按模型能力夹取。

## 工具扩展约束

`customTools` 增加新名称，不能与已有工具重名；`toolOverrides` 只允许覆盖已知内置工具。`noTools` 控制默认工具集合，显式 tools 列表选择具体工具，excludeTools 校验后排除。不要新增一个看起来像内置工具的隐藏别名来绕过选择规则。

ToolContext 提供 cwd、model、thinkingLevel、sessionManager、signal、isIdle、当前系统提示与工具名查询。metadata 声明只读、并发、副作用和交互属性，影响[流式执行资格](agent-loop.md)。outputSchema 属于结果描述元数据，不能替代 execute 中的结果验证。

系统内置插件通过 `SessionPlugin.tools` 注册提问、联网与协作工具，通过 `toolOverrides` 显式覆盖后台 bash；共享 TaskControls 只装配一次。BuiltinPluginRuntime 构造服务并将运行时绑定到冻结快照，桌面只注入通用平台接口。核心不 import Electron、不读取窗口状态，也不依赖桌面 IPC。

公共 `query` 的 `Read`、`Write`、`Edit`、`Bash`、`Glob`、`Grep` 由 `agent-sdk` 参数适配器提供；其后台任务由 SDK 自身管理，并非桌面的持久后台插件。公共工具名与底层四工具的边界见[工具接口区别](../features/tools.md#命令工具的接口区别)。

## 存储和生命周期

SDK 与桌面共用核心的文件回退预检和提交引擎：校验完整修改链、原子替换，提交失败时回滚；桌面在薄适配层额外约束工作区与快照归属。Markdown frontmatter 的语法解析也在核心共享，技能、插件与 Agent 各自保留字段规则。

原生 JSONL 的纯解析与记录链校验集中在 coding-agent；SDK 历史读取复用同一规则，文件修复与工具 journal 恢复仍由可写会话 owner 执行。

SessionManager 可持久化、恢复或仅在内存中工作；内存模式只是不写会话日志，文件和 bash 工具仍有副作用。扩展函数不会被序列化到日志，恢复时需重新提供实现。

设置由用户级 settings.json 和项目 `.zpi/settings.json` 合并，支持注入内存 SettingsManager。读取坏设置会记录错误；不能静默把用户设置视为成功保存。资源加载器和 customInstructions 是不同层，详见[资源](resources.md)。

订阅事件用于展示和持久化协调。异步事件 sink 失败可能阻止后续执行，不能把它当作无关紧要的打印回调。退出前 abort 当前 run，再 dispose 释放订阅和 Responses 连接；独立宿主自己创建的外部服务需自行关闭。ZPI 的七类内置服务由 BuiltinPluginRuntime 负责取消、清理与 drain，宿主在会话结束后等待插件收尾。

`plugins` 与 `hooks` 是原生注入入口。HookRunner 校验输出并控制预算、超时和错误策略；SessionHooks 把结果转换为独立的 synthetic 上下文消息，交给循环持久化。Stop 反馈形成真实下一轮输入，不修改最终回答。工具 hook 存在时关闭流式提前执行。事件、装配和冻结规则见[插件契约](plugins.md)。

## 验证入口

- [SDK 入口](../../packages/coding-agent/src/core/sdk.ts)、[类型](../../packages/coding-agent/src/core/types.ts)、[会话对象](../../packages/coding-agent/src/core/agent-session.ts)、[示例](../../examples/coding-session.ts)。
- [override 测试](../../packages/coding-agent/test/tool-overrides.test.ts)、[运行时测试](../../packages/coding-agent/test/model-runtime.test.ts)、[设置测试](../../packages/coding-agent/test/settings-manager.test.ts)、[会话测试](../../packages/coding-agent/test/session.test.ts)。

## 2026-11 SDK 契约基线

本次对齐固定为 `@anthropic-ai/claude-agent-sdk@0.3.319`，核对日期 2026-11-08。来源为该版本 [npm tarball](https://registry.npmjs.org/@anthropic-ai/claude-agent-sdk/-/claude-agent-sdk-0.3.319.tgz) 的 `sdk.d.ts` 与实现，SHA-512：`7X+sh4uZv/u4OL4I4cQvMr9N3NM6FDiuyk829hFylgbrnNwVyiGElWEDWGuO26zwMIxmgpKdPoDILoFIHh1uwA==`。网页用于解释，不作为浮动版本规范：[存储](https://code.claude.com/docs/en/agent-sdk/session-storage)、[费用](https://code.claude.com/docs/en/agent-sdk/cost-tracking)。不承诺 Claude Code 可以读取 ZPI 格式的 transcript。

| 工作包 | 接口与状态归属 | 明确的边界 |
| --- | --- | --- |
| 审批、计费与校验 | `canUseTool` 返回 allow/deny；本轮主循环 usage、会话累计 cost/modelUsage、本 query 预算分开 | 不支持外部审批通道的 null；报 `SDK_UNSUPPORTED_PERMISSION_NULL` 并阻止执行。该类型收紧需在发布说明标明 |
| 原生存储 | `/host` 的完整 TranscriptStore 类型、`createAgentSession({storage})`、返回 sessionManager | currentState 必填，与 sessionManager 互斥；仍由 fromStore 执行快照、懒读取、写屏障和恢复 |
| 上下文 | `Query.getContextUsage()` 复用原生引擎计算 | provider 实测字段与 estimatedTokens 分开，未知分类不补造；不调用模型 |
| 后台任务 | `Query.stopTask()`、task_started/progress/notification | 普通模式与 TaskStop/Output 共用 Tasks；宿主使用 zpi.taskControl 适配真实后端，缺端口明确失败 |
| 会话管理 | list/info/messages/rename/tag/fork/delete 共享来源解析和校验 | JSONL、内存、镜像分开；SDK 不管理桌面 state.sqlite。活动会话的 mutation 明确拒绝 |
| 子代理历史 | `listSubagents` 返回 agent ID；`getSubagentMessages` 返回带父工具关联的历史 | 公共 SDK 持久子 query 复用同一格式；内存父不留子日志。桌面 listSubagents 仍是定义目录 |
| 外部镜像 | SessionStore、InMemorySessionStore、foldSessionSummary | 本地先写成功后镜像；不是原生存储替代品，不自动接入桌面 |

### 统计与生命周期

`result.usage` 是当前用户输入的主循环用量，包含结构化输出重试，不包含子 query。`total_cost_usd` 与 `modelUsage` 是结果发出时的会话累计值，恢复时从可信的 assistant usage 与 `sdk.child_usage` 记录恢复；模型键为 `provider/model`，避免同名模型跨提供商混淆。子费用只合并一次。旧历史缺失的用量无法追溯，不能解释为完整账单；未配置价格时金额为零。预算只累计本次 query 新增的主/子请求费用，流式输入不会重置。并发请求的预算是请求前检查，可能超出一个在途请求的费用。

后台任务归当前 Query 所有；普通字符串查询在结果前停止并等待未结束任务，确保已结算子费用进入结果。异步输入流的每个结果是当时快照；之后完成的后台子费用写入父记录并进入下一次结果或恢复值。退出取消所有普通任务并 drain 存储。宿主借用模式保留宿主任务所有权，不因 query 退出取消宿主任务。完成后的普通任务重复 stop 成功；未知 ID、跨会话 ID、close 后 stop 明确失败。宿主重复 stop 沿用后端既有规则（有些后端会报告已非 running）。任务通知不是历史运行状态的重新执行指令。宿主恢复同一个 task ID 时按后端 startedAt 投影新的 run_id；每个 run 只发布一次终态。

### 原生装配

```ts
import { createAgentSession, type TranscriptStore, type SessionCurrentState } from "@zpi-dev/agent-sdk/host";
// transcript/currentState 是宿主实现的完整契约；runtime/model 由宿主已有服务提供。
const { session, sessionManager } = await createAgentSession({
  storage: { transcript, currentState }, modelRuntime: runtime, model,
});
```

`sessionManager` 注入继续返回原对象。桌面在创建模型会话之前需要 manager 读取历史，保留其 fromStore 路径；不为使用便利参数改变初始化顺序。桌面 HistoryIndex 的公共类型来自 `/host`。宿主任意服务仍由调用方关闭。

### 镜像协议与来源优先级

SessionStore 公开 append/load、可选 listSessions/listSessionSummaries/delete/listSubkeys；类型以固定版本为基准。SessionKey 为 `{projectKey, sessionId, subpath?}`，主记录省略 subpath；子记录为 `subagents/agent-{agentId}`。默认 projectKey 来自绝对 cwd 的字母数字消毒，长路径采用确定性哈希；ZPI 扩展 `zpi.projectKey` 可显式覆盖，所有 helper 必须传同一 scope。存储只接受 ZPI 记录，保留完整字段；uuid 是稳定幂等键，适配器应去重。摘要只列主记录，用 foldSessionSummary 在 append 内原子/串行维护，mtime 来自存储提交时钟。

普通 query 的 JSONL 是本地权威记录；订阅在成功持久化之后调度镜像。batched 在 100ms、100条、256KiB 或轮次结束刷新，eager 每次提交独立刷新。每个 adapter/key 在进程内串行；跨进程顺序和摘要事务由适配器负责。append 拒绝共尝试三次（短退避），60s 超时不重试，以免未知提交被重复执行；最终发 mirror_error 并继续本地会话。query 退出等待已调度写入，close 会丢弃消费流中的消息；需要接收 mirror_error 时应正常消费到迭代结束。本地错误始终按严格存储失败处理，不转成 mirror_error。

resume 首先 load 镜像；null 才回退同一 SDK 本地 ID，错误不回退。非 null transcript 在 SDK 独占临时目录物化，query 结束/失败后清理；可选 listSubkeys 存在时物化子历史，失败明确传播。continue 与基准一样要求 listSessions，按 mtime 选最新主记录；没有记录则新建。所有 helper 显式传 sessionStore 后只访问该后端，不回退默认本地目录。不存在的 info 返回 undefined、messages 返回 []、重复删除成功；需要现存源的修改/分叉报错。limit/offset 为非负安全整数；消息仍是读取后切片。适配器不提供列表/摘要时 info.lastModified 为 0（未知存储时间）；历史 assistant 失败诊断通过 ZPI 的可选 SessionMessage.error 返回。

删除与分叉需要完整子树：外部后端必须实现 listSubkeys；删除还必须实现 delete。ZPI 在缺方法时明确报 unsupported，不沿用官方 delete 的静默 no-op，避免误报已删除。分叉创建新会话和记录 ID、工具 ID，清除旧用户 UUID 与文件检查点；只复制截点前可关联的子历史，不复用旧 session ID。镜像恢复不支持原地 resumeSessionAt 截断，需 forkSession，避免 append-only 后端出现两条主链。

`sessionStore` 与 persistSession:false、宿主借用会话、enableFileCheckpointing 互斥，启动前拒绝。原生 TranscriptStore 不受这些镜像限制。SDK 不含云数据库驱动、后台保留策略或凭据管理。

会话 helper 的跨键修改不是数据库事务：分叉先读取并校验完整源树，再写新子键，最后提交主记录；失败保留源并尝试清理目标，异常的 sessionId 字段标识可能需回收的目标。外部后端不提供 delete 或无法确认超时提交时，由适配器执行残留清理。SDK 对含桌面运行标记的本地历史拒绝修改，桌面删除必须经过原业务服务。生命周期 Hook 只接受空输出（或 continue:true）；不支持的控制输出通过 hook_response 诊断，block 失败策略仍生效。


### 本轮验证（2026-11-08）

- `npm run check`：类型检查通过；Biome 无错误，保留仓库原有样式警告。
- `npm run test:unit`：344 个测试文件，3918 项通过、1 项跳过，含 SDK、原生存储和桌面回归。
- `npm run build:sdk`：独立 JS 与声明构建通过。将 tgz 安装到隔离消费项目，用严格类型检查（skipLibCheck:false）及 fake provider 验证普通 query、镜像恢复/会话操作、公开原生存储注入。
- quick-chat 隔离副本：替换为该 tgz 后，类型检查、构建、13 项单测、CLI 入口与现有隐藏隔离启动测试（1 项）通过；原仓库源码、锁文件、node_modules 和用户设置保持原状。
- 桌面没有新增渲染或 IPC 交互；历史写屏障、替换恢复、子代理、后台任务与冻结插件沿用单测回归。没有发布 npm、部署站点或向真实模型发请求。
