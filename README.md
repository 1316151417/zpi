# ZPI

**极简的编码客户端。** 参考 ZCode 的界面，结合 Pi Coding Agent 的极简内核，并把同样的减法理念用到客户端：界面干净、清爽，只保留最核心、最常用的功能，让日常编码保持高效。

## 为什么选择 ZPI

- 功能简单，操作直接，没有遥测。
- 以节省 token 和时间为目标，具体对比证据后续补充。
- 代码与功能边界小，易于维护、自定义，也方便在此基础上实现自己的个性化需求。

取舍也很明确：内核只保留 `read`、`write`、`edit`、`bash` 四个工具，不支持子 Agent、MCP、后台任务等高级能力。

## 核心能力

- **模型自由切换**：预置提供商和自定义模型，支持环境变量初始化、手动获取模型列表、启用开关与排序。运行中也能切换；当前执行继续使用旧配置，新消息使用新选择的提供商、模型和思考程度。
- **编码与变更对比**：读写文件、精确编辑、执行命令，查看本轮或整个任务的文件差异。
- **浏览器、终端与文件预览**：在右侧工作区打开页面、终端和文件，保留聊天空间。
- **项目与任务**：选择项目或直接工作，任务置顶、会话恢复、草稿保留。
- **任务通知**：应用不在前台时，任务完成、中断或失败会发送系统通知；点击返回对应任务。在「设置 → 常规」可关闭通知或单独关闭提示音。
- **上下文与消息**：`@` 引用文件、`$` 选择技能、`/init` 初始化项目指令、`/compact` 压缩上下文；运行中可排队消息、立即发送、编辑或删除。

## 安装与使用

前往 [Releases](https://github.com/1316151417/zpi/releases)，下载与你的系统和架构对应的安装包。

启动后，在「设置 → 模型」添加提供商和 API Key、通过「OpenAI（ChatGPT）」登录授权，或配置自定义模型；然后选择项目、选择模型，开始对话。不选择项目也可以直接工作。

支持 DeepSeek、智谱、MiniMax、MiMo 的预置配置，以及 OpenAI ChatGPT 套餐授权。ChatGPT 登录后自动获取当前账号可用模型，支持手动刷新；凭据通过系统加密保存，令牌在请求前自动续期。ChatGPT 使用 Responses API，本地保存完整对话和工具结果，同一任务可与 Chat Completions 模型双向切换；跨模型切换保留文本与工具历史，专有推理签名仅用于原模型。环境变量中的 API Key 只用于初始化尚不存在的提供商；已有配置不会被自动发现覆盖，模型列表仅在首次初始化或手动刷新时获取。

ChatGPT 在线目录缺少 GPT-6.1 Sol、GPT-6 Astra 或 GPT-6 Luna 时，会补充预置配置并标记「待验证」；实际调用仍取决于账号权限，在线目录明确隐藏的型号不会被补充。三个模型默认使用「中」档；Sol、Astra 支持低、中、高、极高、最高，Luna 另外支持关闭。国内模型的默认配置只显示其支持的档位，相同请求参数的映射合并为一个选项。

在「编辑模型配置 → 高级配置」可点击修改推理等级，通过 `+` 新增、删除或拖动排序，也可按 Alt + 左右方向键排序。推理参数映射采用与 ZCode 相同的 CEL 表达式，以 `reasoningLevel` 为变量返回 JSON 请求参数；保存时会验证每个等级。配置的等级用于聊天选择、排队消息和任务恢复，由 `zpi-ai` 统一映射到供应商请求。自定义模型默认使用列表最后一级，预置 GPT 模型保留「中」档默认值。

## 开发与调试

使用 Node.js 24 和 npm。当前桌面构建与本地打包在 macOS Apple Silicon 上验证；编译终端模块需要 Xcode Command Line Tools。

```sh
git clone https://github.com/1316151417/zpi.git
cd zpi
npm install --ignore-scripts
npm run install:electron
npm run install:terminal
npm run dev
```

`npm run dev` 启动 Electron 客户端和 Vite 开发服务器。界面修改通过 HMR 更新，内核、主进程及 preload 修改会自动重启客户端；Ctrl+C 结束开发进程。升级 Electron 后重新运行 `npm run install:terminal`。

异常日志保存在应用数据目录的 `agent/logs/error.log`，与 `agent/sessions` 同级。macOS 开发版为 `~/Library/Application Support/Electron/agent/logs/error.log`，正式版为 `~/Library/Application Support/zpi/agent/logs/error.log`，Preview 版为 `~/Library/Application Support/zpi Preview/agent/logs/error.log`。每行是一个 JSON 记录，包含时间、来源、错误消息、可用堆栈和相关会话/运行 ID；达到 5 MB 后轮换为 `error.log.1`，保留一份旧日志。日志仅存本机，不记录 IPC 参数、完整请求或聊天内容，并屏蔽常见凭据格式；日志写入失败不影响原有错误处理。

调试界面可在 Electron 的 View 菜单打开 Toggle Developer Tools。调试主进程可使用 VS Code 的「zpi: Electron main」配置；也可用 `ZPI_DEV_DEBUG=1 npm run dev` 开放本机 DevTools 调试端口。

常用命令：

```sh
npm run check                # 类型、格式与静态检查
npm run test:unit            # 内核及主进程测试
npm run package:mac          # 构建正式版 macOS DMG，输出到 release/
npm run package:mac:preview  # 构建 ZPI Preview DMG，输出到 release/
npm run test:desktop         # 运行桌面主流程测试（先打包正式版）
```

## Agent SDK

客户端内核同时提供一个小型 `zpi-coding-agent` SDK，方便在脚本中复用模型、四个工具和会话能力。调用示例见 [examples/coding-session.ts](examples/coding-session.ts)，可运行 `npm run example:coding`。

第三方代码和素材的来源、许可见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
