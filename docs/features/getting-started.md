# 新手向导

完成这条路线后，你会拥有一个能接收任务、修改文件并展示结果的本地工作区。

## 安装并打开

安装 Node.js 24 后，推荐通过 npx 直接启动桌面应用：

```sh
npx @zpi-dev/desktop
```

需要固定命令时，通过 npm 全局安装后执行：

```sh
npm install -g @zpi-dev/desktop
zpi-desktop
```

Electron、Sharp 和终端模块作为运行依赖自动安装；安装时需允许依赖的安装脚本下载 Electron 运行环境。应用使用正式版 `ZPI` 数据目录，可通过绝对路径 `ZPI_DATA_DIR` 指定其他目录。使用 npm 包无需克隆源码；参与开发见[本地开发](development.md)。

正式版和 Preview 使用不同数据目录。开发启动与 Preview 共用身份及默认目录，试用存储变更前先阅读[备份与恢复](storage.md)。

## 升级

正常退出应用并按[备份与恢复](storage.md)备份数据后，执行 `npx @zpi-dev/desktop@latest` 启动最新版。全局安装的用户重新执行 `npm install -g @zpi-dev/desktop@latest`，然后运行 `zpi-desktop`。

## SDK 与快速对话

在自己的项目中运行 `npm install @zpi-dev/agent-sdk`，即可使用 [TypeScript Agent SDK](sdk.md)。独立快速对话工具需要 Node.js 24 和 Apple Silicon Mac，设置 `DEEPSEEK_API_KEY` 后执行 `npx @zpi-dev/quick-chat`；也可以执行 `npm install -g @zpi-dev/quick-chat` 后使用 `zpi-quick-chat`。详见 [Quick Chat README](https://github.com/1316151417/zpi-quick-chat#readme)。

## 接入第一个模型

打开设置中的模型页面：

| 已有资源 | 选择 |
| --- | --- |
| 可授权的 ChatGPT 账号 | OpenAI（ChatGPT），通过浏览器登录 |
| OpenAI API Key | OpenAI（API） |
| DeepSeek、智谱、MiniMax、MiMo | 对应预置，区分套餐和按量服务 |
| 其他兼容服务或本地服务 | 自定义提供商，配置地址、协议和模型 ID |

保存后确认有启用的模型。目录能列出模型不代表账号一定有权限；错误时核对地址、认证方式和账号资格。详见[模型与账号](models.md)。

## 按需选择插件

打开“设置 → 插件”，选择需要的系统内置能力，无需另行安装。系统内置插件初始默认启用；记忆默认使用短记忆，联网搜索需单独配置服务凭据并启用提供商后生效。

记忆、子智能体、联网搜索与常规页的相关入口共享插件配置。新任务在首次发送时保存插件快照，之后修改全局默认不重配已开始的任务。完整清单、本地插件添加与生效范围见[插件](plugins.md)。

## 创建任务并了解项目

通过侧栏添加项目，选择本地文件夹。也可以直接创建无项目任务，程序会为草稿分配工作目录。

首次练习使用可恢复的小项目，发送：

> 阅读这个项目，说明入口文件、主要模块和运行方法。先不要修改文件。

查看工具过程，点击文件引用打开预览。对话、文件和终端可以同时保留。

## 完成小改动

明确描述目标、范围和验证方式，例如：

> 将欢迎页标题改为“我的项目”。先找到组件，只改必要文件，再运行相关检查，说明修改内容。

Agent 可以读写文件和执行命令，使用当前用户的系统权限。工作目录不限制它访问机器上的其他路径。

结束后检查“文件已更改”和[审查面板](review.md)，确认 diff 和验证结果。需要独立检出目录时，在首次发送前设置[工作树](projects.md)。

## 补充需求和停止

- 空闲时 Enter 发送，Shift+Enter 换行。
- 回复中发送可以排队，队列可编辑、排序或删除。
- Command/Ctrl+Enter 在运行中停止当前轮后发送草稿；草稿为空时立即发送队首。普通 Enter 仍加入队列。
- 停止结束当前执行，已经完成的文件修改仍然存在。
- 撤销文件改动使用带冲突检查的回退，详见[对话操作](conversations.md)。

## 后续路线

- 补充材料：[上下文、文件和技能](context.md)。
- 调整能力：[插件](plugins.md)、[钩子](hooks.md)。
- 执行中追问：[辅助对话和子智能体](collaboration.md)。
- 查看结果：[文件预览](files.md)、[面板](panes.md)、[终端](background-terminal.md)。
- 连接失败、长时间等待、历史打不开：[诊断](diagnostics.md)。

会话和设置保存在本机；发送请求时所需上下文会发给所选模型服务。联网搜索另外把搜索词或 URL 发给网页服务，详见[联网搜索](web.md)。
