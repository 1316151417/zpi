# ZPI

**给 Agent 更少的工具，给你更多的模型选择。**

ZPI 是一个极简的 AI 编码桌面客户端：参考 ZCode 的界面，采用 Pi 风格的 Agent 内核，把「做减法」同时用在工具、界面和工作流上。读代码、改文件、跑命令、看结果——不必先搭建一套复杂的 Agent 平台。

[下载安装](https://github.com/1316151417/zpi/releases) · [项目介绍](http://101.200.240.206/zpi/) · [GitHub](https://github.com/1316151417/zpi)

## 理念：极简不是少做事，而是少干扰

### 四个基础工具，覆盖日常编码

Agent 内核只保留四个工具：

| 工具 | 用途 |
| --- | --- |
| `read` | 阅读文件和图片，按需加载上下文 |
| `write` | 创建或完整写入文件 |
| `edit` | 精确替换文件中的内容 |
| `bash` | 执行命令、搜索代码、运行脚本和测试 |

不再为搜索、目录浏览、网络请求等操作不断增加专用工具。已有的命令行和脚本生态，就是 Agent 可以使用的能力。

**不内置 MCP、专用 REPL、Browser Use、子 Agent 或后台任务编排。** 当任务需要浏览器自动化时，Agent 可以自行编写浏览器控制脚本，再通过 `bash` 执行；前提是本机具备相应运行环境和依赖。不必为此再引入一组常驻工具。

这里的「不内置」不是封锁能力：你仍然可以让 Agent 使用已安装的命令行程序。客户端的网页预览也只是供人查看结果，不是暴露给 Agent 的浏览器控制工具。

### 界面做减法，模型不做绑定

- **只保留高频工作流**：项目、对话、变更、终端、预览。减少配置负担和界面噪声。
- **模型由你选择**：按任务、成本和使用习惯选择提供商，不把整个工作流锁在一个模型上。
- **没有遥测**：会话和配置保存在本机；模型请求仍会把所需上下文发送给你选择的提供商。
- **代码保持小而清晰**：方便理解、维护和按自己的习惯修改。节省 token 和时间是设计目标，不是未经验证的性能承诺。

## 重要特性

### 1. 多模型接入，同一任务自由切换

预置 **OpenAI（ChatGPT）、DeepSeek、智谱、MiniMax、MiMo**，并区分适用的套餐与按量 API 配置。你也可以自定义提供商的地址、API Key、模型 ID 和能力参数，对接兼容接口的国产模型、其他服务或本地模型服务。

支持三种 API 格式：**OpenAI Chat Completions、OpenAI Responses、Anthropic Messages**。是否可用仍取决于服务端的协议和工具调用兼容性，不是任意模型都能无配置接入。

- 自动初始化预置提供商，手动获取或刷新模型列表。
- 启用、禁用和排序提供商与模型，只显示你常用的选项。
- 按模型选择思考程度，也可在高级配置中自定义推理等级及 CEL 请求参数映射。
- 执行过程中也能更改选择：**当前执行继续使用原配置，后续消息使用新配置**。
- 同一任务可在 ChatGPT Responses 与 Chat Completions 模型之间双向切换，保留文本与工具历史；供应商专有的推理签名只用于对应模型。

### 2. ChatGPT 套餐授权，不用复制网页会话凭据

在「设置 → 模型」选择 **OpenAI（ChatGPT）**，通过浏览器完成 OAuth 登录与套餐访问授权。ZPI 使用授权令牌调用 Responses API，而不是要求你粘贴 ChatGPT 网页 Cookie。

- 登录后获取当前账号的模型目录，支持手动刷新。
- 请求前自动续期令牌；系统加密可用时，凭据加密保存在本机。
- 系统加密不可用时，凭据只保留在当前应用内存，不以明文落盘。
- 完整对话和工具结果保存在本机，便于恢复任务和跨模型续聊。

> 这是 ChatGPT 套餐授权接入，不等同于普通 OpenAI API Key。可用模型、额度及访问资格由账号和 OpenAI 决定；目录中的「待验证」预置模型不代表账号一定有权限。任何第三方客户端都无法承诺「绝不封号」，请遵守提供商条款。

### 3. 从环境变量发现配置，已有设置不被覆盖

如果你已经在开发环境配置了 API Key，ZPI 会在启动时识别以下变量，初始化尚未添加的预置提供商：

| 提供商 | 可识别的环境变量（同一行按顺序取首个有效值） |
| --- | --- |
| DeepSeek | `DEEPSEEK_API_KEY` |
| 智谱 Coding Plan | `ZHIPU_API_KEY` / `ZHIPU_CODING_API_KEY` / `ZAI_CODING_CN_API_KEY` |
| 智谱 API | `ZHIPU_PAYGO_API_KEY` / `ZHIPU_STANDARD_API_KEY` |
| MiniMax Coding Plan | `MINIMAX_API_KEY` |
| MiniMax API | `MINIMAX_PAYGO_API_KEY` |
| MiMo Token Plan | `MIMO_API_KEY` / `XIAOMI_TOKEN_PLAN_CN_API_KEY` |
| MiMo API | `MIMO_PAYGO_API_KEY` / `XIAOMI_API_KEY` |

已有提供商不会被自动发现覆盖，模型目录只在首次初始化或手动刷新时获取。自动发现针对上面的预置变量，不会根据任意环境变量猜测自定义服务。

macOS/Linux 启动时会尝试读取登录 Shell 环境，方便从桌面打开应用时也能发现配置；Windows 使用进程环境。若删除自动导入的提供商但仍保留对应环境变量，下次启动会再次导入。

### 4. 辅助对话：追问，不必打断主任务

主任务正在工作，你想问「这段代码为什么这样改？」或「还有没有另一种方案？」——可以在右侧打开辅助对话。

- 创建时继承主任务已有的稳定上下文，不需要重新解释背景。
- 拥有独立的消息记录、模型选择和运行状态，不把追问写回主任务。
- 可以独立停止或关闭，不中断主任务的执行。
- 不是自动委派的子 Agent，也不会自动接着做主任务。

**辅助对话与主任务共享工作目录，不是文件隔离或只读沙箱。** 提示词要求只有用户明确请求时才修改工作区；若需要隔离代码改动，请使用独立任务的 Git 工作树。

### 5. 编码、检查和查看结果，都在一个工作区

- **文件变更**：查看本轮或整个任务的差异；支持消息编辑、重试、任务分叉和带冲突检查的文件回退。
- **右侧面板**：终端、文件和网页预览，不用离开对话查结果；支持 Markdown、HTML、PDF、Office 文档及媒体的相应预览或打开方式。PPTX 使用系统默认程序打开。
- **项目与任务**：任务置顶、归档、恢复和草稿保留；按项目或时间线浏览，按创建或更新时间排序。
- **Git 工作树**：选择本地或远程起始分支（默认当前分支），首次发送时创建游离 HEAD 的独立工作目录，不自动增加本地分支。远程分支使用本地已同步的记录；需要保留为分支时可在工作树中运行 `git switch -c <分支名>`。
- **任务内搜索**：`⌘F` / `Ctrl+F` 搜索消息与文件变更，高亮定位并加载更早历史。
- **上下文管理**：`@` 引用文件、`$` 选择技能；`/init` 建立项目指令，`/compact` 压缩上下文，另有自动压缩与超限恢复。
- **消息排队**：执行时继续补充需求，支持调整、编辑、删除或立即发送排队消息。
- **任务通知**：应用不在前台时，完成、中断或失败可发送系统通知；通知和提示音均可关闭。

技能和项目指令是按需读取的文本，不是一套新的工具平台。支持项目 `AGENTS.md` 及用户/项目级 `.agents`、`.zpi` 资源目录。桌面端另有可选的结构化用户提问能力，默认关闭；四个基础工具仍是内核边界。

## 开始使用

1. 前往 [Releases](https://github.com/1316151417/zpi/releases)，查看当前发布的安装包。
2. 启动 ZPI，在「设置 → 模型」登录 ChatGPT、填写预置提供商 API Key，或添加自定义模型。已有环境变量可自动初始化预置配置。
3. 选择项目和模型，描述你想完成的工作。也可以不选择项目直接对话。
4. 查看变更与预览，必要时打开辅助对话，或切换模型继续任务。

当前桌面构建和本地打包主要在 **macOS Apple Silicon** 上验证。仓库提供 macOS DMG 与 Windows NSIS 打包命令；具体可下载平台以 Releases 为准。

## 本地开发

使用 **Node.js 24 和 npm**。macOS 原生终端模块需要 Xcode Command Line Tools。

```sh
git clone https://github.com/1316151417/zpi.git
cd zpi
npm install --ignore-scripts
npm run install:electron
npm run install:terminal
npm run dev
```

```sh
npm run check                # TypeScript 与 Biome 检查
npm run test:unit            # 单元测试
npm run test:desktop         # 构建并运行桌面测试
npm run build               # 构建桌面应用
npm run package:mac          # 正式版 macOS DMG
npm run package:mac:preview  # ZPI Preview DMG
npm run package:win          # Windows NSIS 安装包
```

开发客户端以 **ZPI Preview** 身份运行，与打包的 Preview 共用数据目录；正式版使用独立目录。升级 Electron 后需重新运行 `npm run install:terminal`。

架构保持分层：

```text
packages/ai            模型协议、流式响应、认证与历史兼容
packages/agent         Agent 执行循环
packages/coding-agent  四个工具、会话、上下文、资源与 SDK
packages/ui            共享 React 组件与 Markdown 渲染
packages/desktop       Electron 主进程、preload 与桌面界面
```

调试、数据位置和历史迁移说明见 [开发指南](docs/development.md)。介绍页源码位于 [docs/site/index.html](docs/site/index.html)，部署方式见 [部署说明](docs/deployment.md)。

## 小型 Agent SDK

`zpi-coding-agent` 可在脚本中复用模型、四个工具与会话能力。它是桌面内核的小型配套能力，不是另一套复杂框架。

查看 [调用示例](examples/coding-session.ts)，或运行 `npm run example:coding`。

第三方代码与素材的来源、许可见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
