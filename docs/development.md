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

## 桌面测试

`npm run test:desktop` 构建应用后运行 Playwright。默认隐藏窗口、不抢焦点，并静默系统通知和音频；界面仍正常渲染，支持自动交互、截图和失败 trace。

需要观察窗口时运行：

```sh
ZPI_TEST_SHOW_WINDOW=1 npm run test:desktop
```

打包历史测试需要先运行 `npm run package:mac`，或通过 `ZPI_TEST_PACKAGED_APP` 指定包含当前测试模式的应用包。

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
