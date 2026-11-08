# 插件装配与生命周期契约

插件贡献指令、命令、工具及生命周期处理器。`agent` 只提供执行节点；`coding-agent` 负责校验、装配和调度；内置业务规则位于独立的 `builtin-plugins` 包。桌面宿主提供平台服务，不在核心执行循环中判断插件名称。

设置入口、完整内置清单、默认值及用户可见的生效规则见[插件](../features/plugins.md)，命令钩子的配置操作见[钩子](../features/hooks.md)。

## 装配和状态

- SDK 的 `assembleSession` 是工具选择、插件贡献合并和冲突检查的唯一入口。实际会话、提示预览和工具列表使用相同装配规则；装配与预览不执行 hook。
- `SessionPlugin` 用稳定 `id`、`version` 标识，声明静态 instructions、prompt commands、custom tools 和 hooks。内置工具覆盖必须显式使用 toolOverrides；重名和保留命令冲突直接报错。
- 原生插件通过 SDK 显式注入；外部插件通过桌面“添加本地插件”导入，不自动执行项目中的代码。市场安装、更新、MCP 和任意 JS 模块自动发现尚未接入。
- 桌面首次发送冻结插件快照（版本、指令、命令、runtime 和选项），之后切换启用状态不改变已有任务。恢复使用快照中的静态内容，并按冻结的 runtime 与版本绑定原生工具和 hook。
- 插件配置使用 `plugins.enabled` 和 `plugins.options`；会话保存严格校验的冻结快照，不保存能力布尔字段。运行时不包含旧配置或旧 SQLite 兼容迁移。
- 插件页与记忆、联网、子智能体、常规页使用同一份全局插件设置。配置写入成功后，宿主统一广播最新 PublicSettings；记忆页与插件页共用有效模式计算，禁用记忆插件时均显示关闭，再次启用恢复保留的模式。这些设置是新会话默认值，已有会话仍使用冻结快照。

## Hook 契约

循环事件包括 SessionStart、UserPromptSubmit、PreToolUse、PostToolUse、PostToolUseFailure、Stop；四个宿主事件见下方[策略插件与宿主事件](#策略插件与宿主事件)。输入携带 sessionId、cwd、invocationId；工具事件携带 toolCallId、toolName、有效 toolInput。处理器接收独立输入快照和 AbortSignal。

- SessionStart 在会话首次输入前执行一次；失败后可重试，不重复提交已经完成的上下文。
- UserPromptSubmit 在用户消息写入模型历史前执行，可以拒绝输入或追加独立的 synthetic 用户上下文消息，不改写原始输入。
- PreToolUse 在原参数校验后执行，可以拒绝或完整替换输入；每次替换重新经过参数规范化和 schema 校验。
- PostToolUse / PostToolUseFailure 在工具完成后执行，可追加上下文；失败不覆盖已经产生的工具结果、文件事实与 journal。
- Stop 仅在正常最终回答后、真正结束前执行。带反馈时允许继续，连续最多三次；取消、错误、长度截断不触发继续。
- 同一事件按注册顺序执行；拒绝优先；上下文按原顺序在稳定消息边界注入并持久化。处理器不直接修改消息历史。
- 每个 hook 有超时、取消、上下文预算及可观察的执行结果。原生函数的超时结束等待并发送 AbortSignal，处理器必须协作取消自身 I/O。取消始终传播；默认 hook 失败只报告诊断，PreToolUse 可声明 onError:block。
- 存在工具 hook 时关闭流式提前执行，避免 hook 副作用突破只读工具的提前执行资格。后续再引入经过验证的 hook 副作用元数据。

## 内置插件

communication-style、tool-batching、file-links、file-context-reuse、proactive-execution 贡献静态指令。project-init 贡献 `/init` prompt 命令。SDK 默认只保留 `/compact` 控制命令；宿主通过插件显式获得 `/init`。

## 工具运行时插件

- questions、web-search、collaboration、background-tasks 通过版本化 runtime 声明绑定内置包中的服务实现，贡献工具、显式内置工具覆盖及动态指令。宿主通过通用接口提供平台能力，核心包不识别这些插件的 ID，不导入桌面服务。
- `plugins` 设置 version 2 包含 enabled 和 options；协作提示预设使用 collaboration 的 `promptPreset`。插件启停和配置是唯一写入入口。
- 任务首次发送冻结 runtime 标识、版本、选项与静态组件。恢复时必须匹配运行时实现版本，不使用全局开关重配旧任务。联网凭据仍只存在加密凭据存储，移除凭据即时阻止已有任务访问服务。
- 共享 TaskControls 只依赖 TaskBackend 接口，按照真实任务归属选择后端，不按 ID 前缀猜测。后台命令和协作插件分别注册后端；无后端或多个后端声称同一任务均拒绝操作，后端继续校验会话所有权。TaskOutput/TaskStop 仅装配一次。
- 子智能体使用 coordinator 插件提供回复通道；不继承可继续派生子智能体的协作工具。工具白名单、禁用列表和后台任务控制的保留规则由内置插件装配层统一应用。
- 协作插件在 UserPromptSubmit 准备本轮 Agent 定义，动态指令在资源刷新后求值。预览只枚举定义，不启动子任务、联网请求或进程。

验收补充：三类工具启停及重启冻结、提示预设配置、非法/不匹配 runtime 拒绝恢复、后台与协作任务独立启停、任务归属及冲突保护、取消/恢复/输出格式不变、子智能体权限与协调通道、联网凭据移除。

## 验收

覆盖装配冲突与预览无副作用、六个 hook 的真实模型/工具调用链、参数替换重验、拒绝结果配对、post hook 失败保留工具事实、Stop 继续上限与取消、首次输入阻断与重试、五类指令独立启用、重启和插件更新后的冻结内容、`/init` 保留已有 AGENTS.md。

## 策略插件与宿主事件

memory、session-title、notifications 均为版本化运行时插件，默认启用。记忆模式默认 short，可通过 `plugins.options["zpi.memory"].mode` 设置 off/short/long；记忆页与插件页读写同一份选项，模型选择、周期和预算继续由记忆服务设置管理。会话使用 pluginsVersion 3 的冻结插件选项，不使用当前全局模式重配已有任务。

- memory 在 UserPromptSubmit 选择本轮上下文，在成功的 read 后记录来源使用，在 RunEnd 释放根任务选择；批次调度、模型快照与使用状态由 MemoryPolicy 持有。子智能体只继承父任务已选上下文，不能自行启动记忆整理。清空、历史修改和删除仍通过现有持久化边界撤销旧来源。
- session-title 在 InputAccepted 提供临时标题，在 RunStart 启动独立辅助请求。TitlePolicy 持有任务、取消和收尾；手动改名与删除优先于晚到结果，失败不重试，不改变前台请求结果。
- notifications 处理 Notification 事件，通过宿主注入的通知发送接口调用系统服务；根任务范围、归档、聚焦、通知偏好和去重仍生效。通知失败不影响结算。常规页的任务通知与插件页的任务通知是同一个 `plugins.enabled` 开关，PublicSettings.interface.notificationEnabled 仅为派生视图，持久化不再保存第二份总开关。关闭会即时抑制系统通知，声音偏好独立保存；会话中的 hook 装配仍按快照冻结，未装配通知插件的旧会话不会因开启全局开关而获得 hook。

四个通用宿主事件使用同一个 HookRunner：InputAccepted（输入接受准备）、RunStart（接受完成、模型执行前）、RunEnd（成功/取消/失败均触发）、Notification（结算完成后）。SDK 自动调度原有六个循环事件；桌面负责这四个宿主事件，独立 SDK 宿主可以使用导出的 HookRunner 调度。宿主事件不修改输入、工具或历史；需要拒绝输入的插件应使用 UserPromptSubmit。Stop 仍只表示模型正常最终回答，不能用于替代失败和取消清理。关闭时取消宿主 hook 及子进程。

SDK 插件的 `contextInstructions()` 返回以本地块名为键的当前字符串字典，例如 `{ agents: listing, memory: text }`。SDK 负责插件命名空间、比较、去重和缺失块的撤销，不再把它们与基础提示拼成一整份更新。该接口直接使用当前字典形式，不保留旧数组接口；详见[动态上下文和最终请求结构](context.md#基础提示与动态上下文)。

## 本地外部插件

“设置 → 插件”的“已安装”区域显示本地插件数量，顶部提供刷新和“添加 → 从本地文件夹添加”，空状态也提供添加按钮；内置插件单独列出，不提供插件市场。选择根目录后导入并启用。导入只读取、校验和复制文件，不执行 hook、依赖安装或模块入口。实现独立在 `zpi-plugin-compat`，不向 agent/coding-agent 引入 Claude、ZCode 或 Electron 分支。

Manifest 查找顺序：`.zpi-plugin/plugin.json`、`.zcode-plugin/plugin.json`、`.claude-plugin/plugin.json`、`.codex-plugin/plugin.json`。支持 name、version、description、字符串数组 instructions，以及标准 commands、skills、agents、hooks 目录；组件路径可使用 manifest 中的相对路径声明。缺省 version 为 unversioned，仍按内容摘要固定版本。

| 组件 | 接入方式与边界 |
| --- | --- |
| commands/*.md | 使用 `/插件名:命令名` 命名空间；冻结正文与描述，单次替换 `$ARGUMENTS`。不支持命令 Shell 插值或 allowed-tools/model 等改变执行权限的 frontmatter。 |
| skills/*/SKILL.md | 使用 `插件名:技能名`，保留描述、冻结正文和缓存资源路径，通过统一资源装配提供列举及 loadSkill；不加载正文中的 hook、独立 agent 或权限声明。 |
| agents/*.md | 复用已有 Agent 解析、工具白名单和模型选择规则，使用 `插件名:Agent名`；由协作插件列举和委派。权限沙箱、MCP、agent hook 等声明拒绝导入。 |
| hooks/hooks.json | 自动加载标准包装对象；manifest 的 hooks 支持 JSON 文件、inline 对象或数组；同一文件只加载一次。 |
| command/process hook | command 是 shell 字符串，process 是 command + args；支持 timeout（秒）和 timeoutMs（毫秒）。支持当前十个事件与正则 matcher，Bash/Read/Edit/Write/Task 匹配 ZPI 对应工具。 |

暂不支持的事件、异步 hook、HTTP/prompt/agent hook、MCP、LSP、UI、动态 JS 入口及不支持的组件声明在导入阶段明确报错，不静默忽略。

stdin 同时提供原生字段和 hook_event_name、session_id、transcript_path、tool_name、tool_input、tool_use_id、tool_response 等兼容字段；tool_name 使用 Claude 工具别名，toolName 保留原生工具名。提供 ZPI/ZCODE/CLAUDE 的 PLUGIN_ROOT、PLUGIN_DATA、PLUGIN_ID、PLUGIN_NAME 与 PROJECT_DIR 环境变量。插件子进程继承普通 shell 环境和本机权限，不是权限沙箱。

支持 hookSpecificOutput.additionalContext、updatedInput、permissionDecision、顶层 additionalContext/additional_context、continue:false、decision:block 及原生输出字段。输入替换进入 SDK 原有完整校验链；exit 2 使用 stderr 拒绝输入或工具，Stop 转为继续校验的上下文；其他错误遵守已有 hook 错误策略。PreToolUse/UserPromptSubmit 默认在 hook 失败时拒绝，post hook 失败保留已产生的工具事实。permissionDecision:allow 不能绕过现有权限；ask 作为拒绝返回，不伪造批准。

导入文件限单文件 2 MiB、总量 32 MiB、4000 个条目、16 层目录；拒绝符号链接和特殊文件，跳过 .git、node_modules。hook stdin 限 2 MiB，stdout/stderr 合计 128 KiB，超时上限五分钟；超时或取消终止进程树，回收监听器和计时器。上下文仍受核心 24000 字符预算约束。

缓存位于当前 generation 的 `plugins/cache/<sha256>`；数据位于 `plugins/data/<local.id>`。导入相同 ID 的新内容只影响新会话，旧缓存保留用于已冻结会话；数据目录按插件 ID 保留。恢复和执行前校验缓存内容与冻结声明，缺失、改动或版本不匹配均拒绝执行。记忆后台 Agent 不加载外部插件。当前不接入市场、自动更新、远程获取或 MCP。

兼容依据：[Claude hook 参考](https://code.claude.com/docs/zh-CN/hooks)与 ZCode 的 `docs/plugin-hooks-compat.md`；这里实现明确的子集，不声明完整协议兼容。

## 钩子设置与配置归属

“设置 → 钩子”提供范围选择、搜索、列表、创建、编辑、启停、删除与刷新，界面布局参考 ZCode 的 HooksSection、HooksList 与 HookForm。用户和项目配置写入应用 SQLite 的 `hooks.config`，由 ConfiguredHooks 持有；项目范围按已注册项目 ID 选择，不读取或写入项目配置文件。列表与表单不会试运行脚本，刷新也不执行命令。每条配置带 revision，旧版本编辑、删除或启停被拒绝；无效配置不改变已保存数据。最多 256 条，每条命令配置不超过 64 KiB。

首次发送把启用的用户钩子与当前项目钩子合成 `zpi.configured-hooks` 插件快照，运行时为 `host.command-hooks-v1`，内容摘要固定版本。同一事件先运行用户钩子，再运行项目钩子，最后运行插件钩子；各范围内保留配置顺序。恢复校验快照摘要与命令配置，不使用当前设置覆盖已冻结的钩子。子智能体继承冻结快照，记忆后台 Agent 不注册该运行时。关闭或取消沿用通用 HookRunner 与进程树回收机制。

外部插件与配置钩子共享 `plugin-compat/command-hooks.ts` 的解析、别名匹配、命令执行、输出转换与限制，不增加第二套执行器。桌面宿主只绑定经过自身验证的运行时。内置 Hook 的事件、匹配规则和说明由 builtin-plugins 的 `builtinPluginHooks` 统一声明，同时供桌面处理器绑定和只读设置投影使用；设置列表不绑定工具，也不调用处理器。

插件页负责插件整体启停，钩子页对插件自带处理器只读展示，不制造第二份开关。当前兼容范围仍以命令、技能、Agent 定义和支持的 command/process Hook 为主，不接入 MCP、LSP、UI 或插件市场。

## 内置运行时隔离

`builtin-plugins/runtime` 提供 `BuiltinPluginRuntime`，负责七类运行时的构造、装配、恢复、取消与清理。该包不依赖 desktop、UI、Electron 或具体 SQLite 实现；浏览器只加载纯声明、类型和模型选项转换入口。

| 能力 | 内置实现与策略 |
| --- | --- |
| 提问 | `questions.ts`：校验、排队、计时、稍后回答、取消及子智能体转交父任务 |
| 联网 | `web/`：工具定义、参数与 URL 校验、DeepSeek 请求、凭据即时获取、限额与取消 |
| 协作 | `collaboration/`：Agent 定义与覆盖、调度、收件箱、持久投递确认、工具权限、继承、用量和产物 |
| 后台命令 | `background/`：进程生命周期、输出、通知、丢失所有权后的恢复及进程树回收 |
| 记忆 | `memory/`：来源选择与证据、短记忆、后台提取与整理、模型快照、使用跟踪、清空与继承撤回 |
| 标题 | `title/`：临时标题、辅助 SDK 请求、竞态处理与清理；手动命名和删除优先 |
| 通知 | `notifications.ts`：根任务与归档范围、终态文案、三秒去重；平台拒绝投递不占用去重窗口 |

协调回复通道 `desktop.coordinator` 与 TaskOutput/TaskStop 也归内置包；后台命令、协作可分别启停，共享任务控制依据后端所有权路由。静态指令与 `/init` 继续由同包声明，不合并进桌面核心。

`ports.ts` 是宿主注入边界：会话执行与状态更新、稳定历史快照、配置存储、模型运行时与选择校验、凭据读取、文件预览、投影事件、系统通知及错误记录。`SessionHost` 保留会话/子会话的持久化和只读边界、通用 HookRunner、IPC 适配以及历史写入/删除的事务次序；插件负责子任务准备、观察事件、结算续跑、历史失效和资源清理。插件预览只枚举定义，不执行提问、联网、模型调用或后台进程。

关闭时插件 owner 依次停止后台整理、协作、后台命令和标题任务，通知状态同时释放；宿主在结束会话后调用插件 `drain` 等待剩余传输和文件清理。一个 owner 失败仍尝试其余 owner，单个原始错误及多个错误的聚合均保留。声明/运行时分入口，SDK 包保持可单独打包，不依赖桌面或内置插件。

独立包回归：[七类装配、预览、清理与依赖边界](../../packages/builtin-plugins/test/runtime.test.ts)。

回归：[真实子进程与导入](../../packages/plugin-compat/test/compat.test.ts)、[策略冻结与本地装配](../../packages/desktop/test/plugin-policies.test.ts)、[记忆生命周期](../../packages/desktop/test/memory-host-lifecycle.test.ts)、[标题](../../packages/desktop/test/session-title.test.ts)、[系统通知](../../packages/desktop/test/task-notifications.test.ts)。

桌面回归：[跨设置页双向同步、本地导入与浅深色布局](../../tests/desktop/plugins.spec.ts)、[联网开关联动](../../tests/desktop/web-settings.spec.ts)。

钩子设置回归：[CRUD、范围隔离、无副作用预览与会话冻结](../../packages/desktop/test/configured-hooks.test.ts)、[浅深色界面、真实执行和重启](../../tests/desktop/hooks.spec.ts)。
