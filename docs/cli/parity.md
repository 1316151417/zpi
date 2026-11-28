# ZPI CLI 交互对照

日常对话以 Claude Code 为参照，连接提供商和选择模型以 Pi 为参照。验收以用户实际看到的终端、按键后的焦点和发出的模型请求为准。例如 `/fast` 要改变请求的 service tier，`/技能名` 要把选中的 Skill 送进本轮请求。

对照固定在本地 Claude Code 社区版本 `a90626dc` 和 Pi `e65b3b88`。核查包含命令注册、条件命令、启动参数、工具、默认键位和相应的界面组件。社区版本含有自己的扩展和内部门控，表中的命令数量不能当成 Anthropic 官方发行版的功能数量。[Claude 命令注册](https://github.com/claude-code-best/claude-code/blob/a90626dc1e349b3f053fd5b46d7ba8413799c699/src/commands.ts) · [Claude 键位表](https://github.com/claude-code-best/claude-code/blob/a90626dc1e349b3f053fd5b46d7ba8413799c699/src/keybindings/defaultBindings.ts) · [Pi 模型交互](https://github.com/1316151417/pi/blob/e65b3b88c08412bb8ffbd21fb5dc5756064a6e5a/packages/coding-agent/docs/models.md)

## 从启动到下一轮

| 操作 | ZPI CLI 的实际行为 | 与参考的关系 |
| --- | --- | --- |
| 启动 | 暖色粗体 `ZPI`，低对比度路径，用户目录缩写为 `~`。输入框以 `❯` 起行。 | 保留文字品牌和弱化路径的层级。首页按产品要求省去欢迎语、吉祥物和常驻快捷键。 |
| 查看当前设置 | 底栏显示 `provider/model`、已知且开启的推理档位、实际启用的加速。已选 Skill 和运行状态按需出现。 | 帮助放在 `?` 和 `/help`，模型选择器内才提示如何保存默认值。 |
| 发送和阅读 | 用户输入使用整行底色和 `❯`，模型回答以 `●` 起行。多行、Markdown、终端缩放都有续行缩进，关闭颜色后仍能辨认发言人。 | 对照 Claude 的用户消息、回答和连续对话截图，历史回放继续使用两种消息样式。 |
| 等待回答 | 收到思考事件时显示「思考中…」，收到结束事件后显示耗时。Ctrl+O 展开供应商返回的可见思考，也展开工具输出。回答结束后另列本轮用时。 | 计时来自本次运行。只有 reasoning token 用量或历史缺少时间时显示「已思考」。无依据时不补计时，签名、加密或遮盖内容始终不可见。 |
| 调用工具 | read、edit、write、bash 显示目标、状态和结果。Ctrl+O 展开输出及内核提供的修改差异。重试、压缩、中断和失败有独立反馈。 | 复用四个原生工具。Claude 的工具家族、逐文件 Git 差异浏览器和任务面板另列于下。 |
| 输入命令或 Skill | 输入 `/` 同列公共 Skill、文件命令和内置命令。Tab 补全后可追加要求，`/<Skill 名> 要求` 直接调用。冲突时保留原有命令，并展示该 Skill 的可用拼写。 | 自定义资源在提交时重新读取。显式 Skill 也可用于 `-p`，终端整段粘贴中的斜杠正文按原文发送。续聊回放保留这版记录的原始输入，避免把整份 Skill 当作用户说的话。 |
| 引用资料 | `@` 补全当前目录文件或目录，图片路径使用现有的校验、转码及模型输入能力检查。 | Ctrl+V 通过 pi-tui 的系统剪贴板读取图片，在草稿中插入可删除的标记。发送时走同一套图片校验；终端主机取不到图片时可用 `@`。 |
| 编辑与中断 | 中文及多行粘贴、换行、光标编辑、上下键历史、Ctrl+R 搜索最近输入。Esc 先关闭补全，再中断运行；Ctrl+C 可清空草稿，空输入 Ctrl+D 退出。 | Ctrl+R 搜索本次终端最多 100 条不同输入。打开选择器再取消，返回原草稿。 |
| 续聊 | `-c` 续最近记录，`-r` 或 `/resume` 可搜索当前目录的会话，`-r <id>` 精确恢复。`/rename 名称` 用原生会话名称标记，`/clear` 开新草稿。 | 保持目录隔离。只选模型、看帮助或打开后退出均不增加会话。 |
| 取走回答 | `/copy` 复制最近可见回答，`/copy 2` 复制倒数第二条，使用终端 OSC 52。普通 `-p` 向 stdout 写本轮可见结果。 | 终端决定是否接收剪贴板写入。纯文本管道不带屏幕符号、思考、进度或工具日志。 |

## 配置模型时按 Pi 操作

| 用户想做什么 | 入口与结果 |
| --- | --- |
| 第一次连接 | `/login` 选提供商，或直接 `/login anthropic`。已知服务只询问所需的凭据；自定义网关另选协议和地址。模型目录自动发现，缺少目录的兼容服务可手填多个模型。 |
| 看有哪些模型 | `zpi models` 每行一个 `provider/model`；`zpi --list-models writer` 筛选。普通登录和模型名均无需填写账户别名。 |
| 改当前会话 | `/model` 或 Ctrl+L 打开可搜索列表，显示当前项和默认项。Enter 切换。`/model provider/model` 或唯一完整模型 ID 直接选中，关键词和重名 ID 打开搜索。Ctrl+P / Ctrl+Shift+P 前后切换。Alt+P 也可按 Claude 习惯打开列表。 |
| 设置新会话默认 | 在模型上按 Ctrl+S；也可执行 `zpi models --default provider/model`。首次登录按服务目录顺序取第一项；已有默认值保留。 |
| 做单次调用 | `zpi-cli -m provider/model` 或 `--model provider/model`。只按首个斜杠拆分，可用 `team/org/writer` 这样的 ID。 |
| 调推理或加速 | `/effort` 和 Shift+Tab 使用模型支持的档位，`--effort` 作用于本次调用。`/fast` 或 Alt+O 切换已声明的服务档位。 |
| 管理第二组凭据 | `zpi auth login <provider> --account work` 可添加同提供商的其他连接，`auth list/switch/logout` 管理计费身份。续聊默认绑定原账户。普通单账户工作流只需知道提供商和模型。 |

Pi 还支持常用模型范围（`/scoped-models`、`--models`）、模型目录在线刷新、llama.cpp 路由管理以及 JSON 覆盖提供商元数据。ZPI 当前在登录时发现目录，搜索和轮换当前各服务的可用模型，自定义地址和协议也走终端向导。模型协议、凭据储存和订阅授权由 ZPI 自己的接入决定。[Pi 模型选择器](https://github.com/1316151417/pi/blob/e65b3b88c08412bb8ffbd21fb5dc5756064a6e5a/packages/coding-agent/src/modes/interactive/components/model-selector.ts) · [ZPI 模型配置](models.md)

## 仍能感知到的差异

| 场景 | 当前边界或具体缺口 |
| --- | --- |
| 长对话阅读 | 可使用终端回滚和 Ctrl+O。Claude 还有专门的 transcript 浏览器、搜索、逐消息操作菜单，以及工具专用详情布局。ZPI 目前没有这些浏览控件。 |
| 草稿和附件 | Ctrl+G 通过 VISUAL 或 EDITOR 编辑草稿，Ctrl+S 暂存或取回一条草稿，连同已选 Skill 和图片一起恢复。尚无跨进程草稿、跨会话输入索引，以及单独管理附件的面板。 |
| 搜索与恢复 | 当前目录内可按标题和 ID 查找会话。Claude 还可跨项目搜索、从某一条消息恢复、分支和回退工作区；后者需要相应的会话与文件生命周期。 |
| 输出及脚本 | 普通管道只输出当轮结果。Claude 的完整 transcript 导出、结构化流、输入事件回显、预算和 SDK 服务模式均有额外契约。 |
| 品牌与显示 | 使用 ZPI 自有文字品牌、中文反馈和终端配色。没有复刻 Claude 的品牌美术、随机动词、可定制状态栏、主题设置页或订阅营销信息。 |

审批、权限模式、计划、MCP、workflow、多代理协同、后台调度、远程控制、worktree 管理，以及 `/commit`、`/review`、`/summary` 和同类代理指令属于已明确排除的能力。项目与长任务管理由 Desktop 承担。上述取舍与输入框、消息呈现、选模等日常交互的完成度分别验收。[产品原则](README.md) · [原生工具与会话边界](runtime.md)

## 静态入口索引

命令按模块归组，涵盖注册表、条件模块及目录中留存的实现。模块名有时与公开命令名或别名不同，例如注册表单独将 `ultrareview` 接入评审。辅助模块和测试目录不计入。

| 处理方式 | 参考源码标识 |
| --- | --- |
| 提供同名入口；差异见上表 | `clear`、`compact`、`context`、`copy`、`effort`、`exit`、`fast`、`help`、`init`、`login`、`logout`、`model`、`rename`、`resume`、`skills` |
| 用已有入口完成主要操作 | `files`、`history`、`keybindings`、`provider`、`status`、`statusline`、`version` |
| 会话、差异和项目辅助；仅支持上表所列的当前目录操作 | `add-dir`、`branch`、`btw`、`diff`、`export`、`fork`、`rewind`、`session`、`tag` |
| 提交、评审、总结或自动生成专用流程；产品排除 | `autofix-pr`、`brief`、`bughunter`、`commit`、`commit-push-pr`、`init-verifiers`、`pr_comments`、`recap`、`review`、`security-review`、`subscribe-pr`、`summary`、`thinkback`、`thinkback-play` |
| 多代理、任务、自治与后台进程；无 CLI 宿主 | `advisor`、`agents`、`agents-platform`、`assistant`、`attach`、`autonomy`、`claim-main`、`coordinator`、`daemon`、`detach`、`goal`、`job`、`monitor`、`peers`、`pipe-status`、`pipes`、`proactive`、`schedule`、`send`、`tasks`、`torch`、`workflows` |
| 审批、计划、插件和专用工具生态；沿用 ZPI 现有执行范围 | `hooks`、`mcp`、`mode`、`permissions`、`plan`、`plugin`、`reload-plugins`、`sandbox-toggle`、`skill-learning`、`skill-search`、`skill-store`、`ultraplan`、`web-tools` |
| 跨设备、仓库、消息平台的连接与安装；Desktop 独立 | `bridge`、`bridge-kick`、`chrome`、`desktop`、`ide`、`install-github-app`、`install-slack-app`、`mobile`、`remote-env`、`remote-setup`、`remoteControlServer`、`share`、`teleport` |
| 应用设置、主题、个性化、安装和发行运营；仅保留必要的模型与凭据入口 | `buddy`、`color`、`config`、`env`、`feedback`、`install`、`issue`、`lang`、`onboarding`、`output-style`、`passes`、`poor`、`privacy-settings`、`release-notes`、`stickers`、`terminalSetup`、`theme`、`tui`、`upgrade`、`vim`、`voice` |
| 产品专属数据、记忆、额度和遥测；CLI 只展示已有本轮上下文与运行状态 | `artifacts`、`cost`、`ctx_viz`、`extra-usage`、`insights`、`local-memory`、`local-vault`、`memory`、`memory-stores`、`rate-limit-options`、`stats`、`usage`、`vault` |
| 内部运维、回填及诊断；没有对应的公共 CLI 服务 | `ant-trace`、`backfill-sessions`、`break-cache`、`debug-tool-call`、`doctor`、`force-snip`、`good-claude`、`heapdump`、`mock-limits`、`oauth-refresh`、`perf-issue`、`reset-limits` |

<details>
<summary>启动参数与子命令</summary>

核对 `src/main.tsx` 内直接声明的长参数（含子命令参数，动态或其他模块声明另计）。ZPI 对外参数以自己的 `--help` 为准。[Claude 启动入口](https://github.com/claude-code-best/claude-code/blob/a90626dc1e349b3f053fd5b46d7ba8413799c699/src/main.tsx) · [ZPI 参数](../../packages/cli/src/args.ts)

| 处理方式 | 参考源码标识 |
| --- | --- |
| 有对应的会话调用 | `--continue`、`--effort`、`--model`、`--print`、`--resume` |
| 基础操作有等价入口（帮助、公共文件、临时打印、认证、详情等），参数不逐字兼容 | `--bare`、`--file`、`--init`、`--init-only`、`--list`、`--no-session-persistence`、`--status`、`--text`、`--thinking`、`--verbose` |
| 模型、成本、脚本事件协议、工具授权和系统提示等高级控制 | `--add-dir`、`--advisor`、`--allow-dangerously-skip-permissions`、`--allowed-tools`、`--allowedTools`、`--append-system-prompt`、`--append-system-prompt-file`、`--betas`、`--dangerously-skip-permissions`、`--dangerously-skip-permissions-with-classifiers`、`--delegate-permissions`、`--disable-slash-commands`、`--disallowed-tools`、`--disallowedTools`、`--enable-auto-mode`、`--fallback-model`、`--include-hook-events`、`--include-partial-messages`、`--input-format`、`--json`、`--json-schema`、`--max-budget-usd`、`--max-thinking-tokens`、`--max-turns`、`--output`、`--output-format`、`--permission-mode`、`--permission-prompt-tool`、`--plan-mode-required`、`--replay-user-messages`、`--safe`、`--sdk-url`、`--setting-sources`、`--settings`、`--system-prompt`、`--system-prompt-file`、`--tools` |
| 云端、后台代理、项目生命周期、MCP 或平台专用子命令 | `--afk`、`--agent`、`--agent-color`、`--agent-id`、`--agent-name`、`--agent-teams`、`--agent-type`、`--agents`、`--assistant`、`--auth-token`、`--channels`、`--chrome`、`--claudeai`、`--clear-owner`、`--client-secret`、`--console`、`--cowork`、`--dangerously-load-development-channels`、`--deep-link-last-fetch`、`--deep-link-origin`、`--deep-link-repo`、`--enable-auth-status`、`--fork-session`、`--from-pr`、`--host`、`--ide`、`--idle-timeout`、`--maintenance`、`--max-sessions`、`--mcp-config`、`--mcp-debug`、`--messaging-socket-path`、`--no-chrome`、`--owner`、`--parent-session-id`、`--plugin-dir`、`--port`、`--proactive`、`--rc`、`--remote`、`--remote-bin`、`--remote-control`、`--resume-session-at`、`--rewind-files`、`--session-id`、`--sso`、`--strict-mcp-config`、`--task-budget`、`--tasks`、`--team-name`、`--teammate-mode`、`--teleport`、`--tmux`、`--workload`、`--workspace`、`--worktree` |
| 其余局部选项，随参考版本的子命令生效；无对应 CLI 参数 | `--all`、`--available`、`--brief`、`--debug`、`--debug-file`、`--debug-to-stderr`、`--deep`、`--description`、`--dry-run`、`--email`、`--force`、`--hard-fail`、`--keep-data`、`--local`、`--name`、`--pending`、`--prefill`、`--scope`、`--sparse`、`--subject`、`--unix` |

同文件直接声明的子命令动词（含嵌套命令，同名合并）共 48 个。认证的 login、logout 和连接列表由 ZPI 自己的 `auth` 处理；会话恢复走 `-r`。其余用于参考产品的安装、配置、MCP、插件、任务或远程服务。

`add`、`add-from-claude-desktop`、`add-json`、`agents`、`assistant`、`auth`、`auto-mode`、`autonomy`、`cancel`、`completion`、`config`、`create`、`critique`、`defaults`、`dir`、`disable`、`doctor`、`enable`、`error`、`export`、`flow`、`flows`、`get`、`install`、`list`、`log`、`login`、`logout`、`marketplace`、`mcp`、`open`、`plugin`、`remote-control`、`remove`、`reset-project-choices`、`resume`、`rollback`、`runs`、`serve`、`server`、`setup-token`、`ssh`、`status`、`task`、`uninstall`、`up`、`update`、`validate`

</details>

<details>
<summary>默认键位上下文与工具</summary>


| 处理方式 | 参考源码标识 |
| --- | --- |
| 输入、补全、历史和通用选择采用共享编辑器或选择器 | `Autocomplete`、`Chat`、`FormField`、`Global`、`Help`、`HistorySearch`、`Select` |
| 对应动作各有入口；详情开关、文件引用、终端回滚、底栏及 Pi 模型选择取代专用面板 | `Attachments`、`EffortPanel`、`Footer`、`ModelPicker`、`Scroll`、`Transcript` |
| 参考版独有的屏幕或复杂流程；ZPI 没有相应菜单 | `Confirmation`、`DiffDialog`、`MessageActions`、`MessageSelector`、`Plugin`、`Settings`、`Tabs`、`Task`、`ThemePicker` |

工具层逐类核对了文件读写、搜索、命令执行、Skill、Notebook、LSP、Web、交互提问、规划、任务/代理、worktree、MCP、工件和专属工具。ZPI CLI 暴露内核原有的 read、write、edit、bash，复用原生 Skill 资源。文件搜索可由 bash 执行，工具结果可展开；协议、权限、后台宿主和第三方专属工具均不会凭空注册。[Claude 工具注册](https://github.com/claude-code-best/claude-code/blob/a90626dc1e349b3f053fd5b46d7ba8413799c699/src/tools.ts) · [ZPI 原生会话](../../packages/coding-agent/src/core/sdk.ts)

</details>

## 回归验证

渲染测试覆盖窄屏和宽屏、不同发言人、正常与遮盖思考、工具更新和历史回放。端到端测试启动真实 bin 和 PTY，连接本地协议服务，以收到的 HTTP 请求核对真实模型 ID、账户归属、Skill 正文和加速参数，并从另一个进程验证保存默认模型和恢复会话。线上订阅授权不属于本次界面对照。[渲染测试](../../packages/cli/test/tui.test.ts) · [真实终端测试](../../packages/cli/test/terminal.pty.mjs)
