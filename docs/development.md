# 开发与调试

安装和常用命令见 [README](../README.md)。使用 Node.js 24 和 npm；当前桌面构建与本地打包主要在 macOS Apple Silicon 上验证。

## 开发客户端

`npm run dev` 以 ZPI Preview 身份启动 Electron 和 Vite，与打包的 Preview 共用数据目录和钥匙串身份；正式版使用独立的 ZPI 目录。开发版与 Preview 应轮流运行。

界面修改通过 HMR 更新，内核、主进程及 preload 修改会自动重启客户端；Ctrl+C 结束开发进程。升级 Electron 后重新运行 `npm run install:terminal`。macOS 编译终端模块需要 Xcode Command Line Tools。

在 Electron 的 View 菜单打开 Toggle Developer Tools。主进程调试可使用 VS Code 的「ZPI: Electron main」配置；也可用 `ZPI_DEV_DEBUG=1 npm run dev` 开放本机 DevTools 调试端口。

## 本地数据与凭据

模型配置在应用数据目录的 `settings.json`，加密凭据在 `credentials.enc`，会话在 `agent/sessions`。

macOS 数据目录：

- 正式版：`~/Library/Application Support/ZPI/`
- 开发版与 Preview：`~/Library/Application Support/ZPI Preview/`

凭据使用 Electron 系统加密；系统加密不可用时，只在本次应用内存中保留凭据，不以明文保存。没有遥测不代表模型请求不出网：当前上下文仍会发送给所选择的模型提供商。

### 环境变量导入

环境变量只初始化尚不存在的预置提供商，不覆盖已有设置。删除自动导入的提供商后，只要启动环境仍带有对应 API Key，下次启动就会再次导入。

注释 Shell 配置中的 `export` 不会清除已有终端的变量。应在启动终端中执行相应的 `unset`（例如 `unset MINIMAX_API_KEY MINIMAX_PAYGO_API_KEY`），或关闭旧终端后打开新终端，再删除该提供商并重启。

## 异常日志

日志位于应用数据目录的 `agent/logs/error.log`，与 `agent/sessions` 同级。每行是一个 JSON 记录，包含时间、来源、错误消息、可用堆栈及相关会话/运行 ID。

达到 5 MB 后轮换为 `error.log.1`，保留一份旧日志。日志仅存本机，不记录 IPC 参数、完整请求或聊天内容，并屏蔽常见凭据格式；日志写入失败不影响原有错误处理。

## 工具与会话边界

- `packages/coding-agent` 的默认工具是 `read`、`write`、`edit`、`bash`。SDK 用 `customTools` 增加工具，用 `toolOverrides` 显式替换同名基础工具，不依赖 Electron。
- 桌面端的 `SessionHost` 负责注入 `AskUserQuestion`、子智能体工具和后台版 `bash`。子智能体通过 `Agent`、`SendMessage` 委派和沟通，通过 `RespondToCoordinator` 汇报；`TaskOutput`、`TaskStop` 统一读取和停止子任务与后台命令，关闭子智能体插件后仍提供这两个后台任务工具。
- 「插件能力」中的提问、子智能体和提示词选项目前均默认开启，已有设置中的显式选择会保留。新对话首次发送时保存配置快照；之后修改全局开关不会重配已有对话。提示词开关不构成权限沙箱，也不会禁用底层并行执行能力。
- 辅助对话是用户手动创建的独立会话，只复制创建时的稳定上下文和配置。子智能体是桌面编排的受委派任务。两者都共享父任务的工作目录；Git 工作树只提供独立检出目录，不隔离操作系统权限。

### Bash 生命周期

SDK 原生 `bash.timeout` 使用**秒**，不传时没有默认超时；超时或取消会终止命令。桌面覆盖实现使用**毫秒**：前台默认等待 120,000 ms，工具参数最大 600,000 ms；超时可转后台，单独以 `sleep` 开头的命令则终止。`run_in_background` 显式转后台后立即返回任务 ID。

后台进程跨主任务回合保留。中断主任务当前回合不会清理已转后台的命令；`TaskStop`、停止子智能体、归档/删除会话和正常退出应用会清理相应进程树。异常退出后不能保证子进程已清理；重启仅恢复历史并把原运行中任务标记为失联，不重启任务，也不凭历史 PID 杀进程。

输出直接落盘，模型输出预览有长度上限，侧栏按需读取末尾 64 KiB。后台输出达到 5 GiB 时停止；子智能体命令转后台后最多运行一小时。`TaskOutput` 默认等待 30,000 ms，最长 600,000 ms；`block=false` 立即返回。完成结果会自动回传，避免反复轮询。

实现入口：[SDK](../packages/coding-agent/src/core/sdk.ts)、[默认能力](../packages/desktop/src/shared/config.ts)、[会话装配](../packages/desktop/src/main/session-host.ts)、[后台命令](../packages/desktop/src/main/background-tasks.ts)。

## 测试

### 单元与服务测试：不启动窗口

`npm run test:unit` 只运行 `packages/*/test/**/*.test.ts`，使用 Node 环境，不启动 Electron、浏览器或桌面窗口。部分用例会启动本地假模型 HTTP 服务、Git 或 Shell 子进程，并使用临时目录；它们不是纯函数测试，但不需要 GUI。

每个测试文件在独立的临时 HOME、配置与缓存目录、系统临时目录中运行，并清除继承的 Shell 启动脚本变量；测试环境在所有清理钩子结束后移除这些目录，避免读取用户配置或清理真实会话的临时日志。

先运行与改动相关的文件，再跑完整套件：

```sh
npm run test:unit -- packages/desktop/test/side-chat.test.ts
npm run test:unit -- packages/coding-agent/test/context-usage.test.ts
npm run test:unit
```

默认最多使用 50% 的可用测试 worker，给本机其他工作留出 CPU 余量，并保留测试文件间隔离。专用测试环境可运行 `npm run test:unit -- --maxWorkers=100%` 使用更多 worker；实际耗时取决于 CPU、内存和其他负载，不保证增加并发就更快。

新增测试优先验证公开行为、失败路径和并发边界；同类输入用参数化用例覆盖，避免在多个层次重复相同断言。需要真实 renderer/preload/main 交互时再增加桌面测试，不以测试数量代替覆盖价值。

### 桌面集成测试：启动隐藏的 Electron

`npm run test:desktop` 构建应用后运行 Playwright。测试使用临时数据目录和本地假模型服务；默认隐藏窗口、禁用窗口焦点，并静默系统通知和音频。界面仍正常渲染，支持自动交互、截图和失败 trace。隐藏窗口不等于无图形依赖：仍需要可运行 Electron 的环境，Linux 无桌面环境通常需要虚拟显示服务。

所有桌面用例应复用 `tests/helpers/desktop.ts`：它将 Home、XDG 和 Windows 应用数据目录指向临时目录，移除继承的 Shell 启动脚本变量，将文本剪贴板留在内存中，并拒绝未显式模拟的原生打开文件、浏览器和文件管理器操作。需要验证这些操作时，在用例中提供假实现，不启动用户的外部应用。

定向运行不需要安装包的用例：

```sh
npm run test:desktop -- tests/desktop/assistant-flow.spec.ts
```

需要观察窗口时运行：

```sh
ZPI_TEST_SHOW_WINDOW=1 npm run test:desktop
```

完整套件还包含打包历史和终端测试，需要已有 macOS `.app`，仅执行 `npm run build` 不足以运行这些用例。可先运行 `npm run package:mac`；不需要 DMG 时也可只生成目录包：

```sh
npm run build
npx electron-builder --mac dir
ZPI_TEST_PACKAGED_APP="$PWD/release/mac-arm64/ZPI.app" npm run test:desktop
```

路径按实际产物调整，测试默认查找 `release/mac-arm64/ZPI.app`。`ZPI_TEST_PACKAGED_APP` 指定的应用必须包含当前测试模式；测试会把应用复制到临时目录后运行，验证它不依赖仓库中的依赖。其他平台只选择支持该平台的用例，不应把未运行的 macOS 打包测试记作通过。

`docs/specs/` 和 `docs/evidence/` 保留实现时的设计、引用版本和验收记录。其中的测试数量、机器路径及当时未运行的检查只描述该次工作，不是当前覆盖率、当前工作树状态或后续改动的测试豁免。

## 临时历史会话修复（0.2.3 命名变更）

先退出 ZPI、ZPI Preview 和开发客户端，再运行：

```sh
npm run repair:sessions -- --dry-run
npm run repair:sessions
# 指定包含 agent/sessions 的应用数据目录，而不是项目目录：
npm run repair:sessions -- "/path/to/app-data"
```

默认检查正式版与 Preview 的应用数据目录。脚本将旧会话格式、内部记录和系统段落键改为小写 `zpi`，按默认值补齐缺失的能力配置，保留已有配置和消息正文。

修改前在数据目录旁备份原始会话与索引，修改后移除旧索引，重启应用时自动重建。已修复数据重复运行不会写入或新建备份。此命令、`scripts/repair-sessions.ts` 及其测试仅短期保留，迁移完成后可一并删除。

## 命名约定

产品展示和自然语言文案使用 **ZPI**；npm 包、隐藏目录（`.zpi`）、应用 ID、IPC、存储键和前端技术前缀使用小写 `zpi`；环境变量和全大写常量使用 `ZPI_*`。

应用显示名及其对应的 `ZPI.app`、`ZPI Preview` 数据目录保留品牌大小写。OpenAI 对接是明确例外：ChatGPT 授权参数 `agent_name_hint` 和 Responses 工具命名空间保留大写 `ZPI`，不要随内部技术命名修改。
