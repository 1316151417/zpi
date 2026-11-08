# ZPI 文档索引

ZPI 以四工具执行内核和 TypeScript Agent SDK 为基础。提问、联网、子智能体协作、后台命令、记忆、自动标题和任务通知通过系统内置插件按需配置与启停；桌面工作区提供对话、文件、终端与审查界面。

桌面端不支持 Windows，当前主要在 macOS Apple Silicon 上验证。推荐使用 Node.js 24，通过 `npx @zpi-dev/desktop` 启动桌面应用。需要固定命令时，运行 `npm install -g @zpi-dev/desktop`，然后使用 `zpi-desktop`。模型账号在应用设置中配置，应用使用正式版 `ZPI` 数据目录。

- [总览设计与模块地图](docs/design.md)
- [新手向导](docs/features/getting-started.md)
- [系统内置与本地插件](docs/features/plugins.md)
- [源码到文档的完整索引](docs/internals/module-map.md)

| 主题 | 功能讲解 | 原理剖析 |
| --- | --- | --- |
| 模型与账号 | [接入与配置](docs/features/models.md) | [提供商](docs/internals/providers.md) · [ChatGPT 登录与令牌](docs/internals/openai-auth.md) · [WebSocket](docs/internals/openai-websocket.md) · [协议转换](docs/internals/model-protocols.md) |
| 对话与执行 | [对话操作](docs/features/conversations.md) | [会话生命周期](docs/internals/sessions.md) · [Agent 循环](docs/internals/agent-loop.md) · [输入队列](docs/internals/input.md) · [失败恢复](docs/internals/recovery.md) |
| 项目与任务 | [项目和工作树](docs/features/projects.md) | [目录、组织与工作树](docs/internals/projects.md) |
| 上下文与技能 | [上下文管理](docs/features/context.md) | [压缩与媒体预算](docs/internals/context.md) · [指令和技能加载](docs/internals/resources.md) |
| 自定义命令 | [编写和导入](docs/features/commands.md) | [存储、展开与执行](docs/internals/commands.md) |
| 文件与命令工具 | [四个基础工具](docs/features/tools.md) | [读取、编辑与执行机制](docs/internals/tools.md) |
| 协作与提问 | [辅助对话和子智能体](docs/features/collaboration.md) | [子智能体](docs/internals/subagents.md) · [结构化提问](docs/internals/questions.md) |
| 后台命令与终端 | [使用方式](docs/features/background-terminal.md) | [进程与 PTY 生命周期](docs/internals/background-terminal.md) |
| 联网搜索 | [搜索与来源](docs/features/web.md) | [请求、限流和图标加载](docs/internals/web.md) |
| 记忆 | [短期与长期记忆](docs/features/memory.md) | [提取、整合与恢复](docs/internals/memory.md) |
| 文件与预览 | [浏览和预览](docs/features/files.md) | [文件树和格式渲染](docs/internals/previews.md) |
| 变更审查 | [查看和回退](docs/features/review.md) | [Diff、快照与回退](docs/internals/review.md) |
| 面板和浏览器 | [标签与完整视图](docs/features/panes.md) | [面板状态和原生视图](docs/internals/panes.md) |
| 快捷键 | [默认键与改键](docs/features/shortcuts.md) | [事件路由和焦点](docs/internals/shortcuts.md) |
| 界面 | [显示和通知](docs/features/appearance.md) | [流式渲染与阅读位置](docs/internals/rendering.md) |
| 搜索 | [查找任务和文件](docs/features/search.md) | [索引、分页和高亮](docs/internals/search.md) |
| 本地数据 | [备份与恢复](docs/features/storage.md) | [业务存储](docs/internals/storage.md) · [历史与 Worker](docs/internals/history.md) |
| 诊断 | [故障排查与用量](docs/features/diagnostics.md) | [错误、日志和计量](docs/internals/diagnostics.md) |
| SDK | [脚本接入](docs/features/sdk.md) | [装配和扩展接口](docs/internals/sdk.md) |
| 插件与 Hook | [插件管理与生效范围](docs/features/plugins.md) · [钩子配置](docs/features/hooks.md) | [组件装配、生命周期与运行时隔离](docs/internals/plugins.md) |
| 开发 | [环境与调试](docs/features/development.md) | [启动与构建链路](docs/internals/development.md) · [Electron 边界](docs/internals/runtime.md) |
| 测试 | [运行和选择测试](docs/features/testing.md) | [隔离与清理机制](docs/internals/testing.md) |
| npm 分发 | [构建与发布](docs/features/packaging.md) | [产物与原生依赖](docs/internals/packaging.md) |

- 本地阅读文档：`npm run docs`（或仓库内 `npx zpi-docs`），默认打开 <http://127.0.0.1:4400>
- [npm 桌面包](https://www.npmjs.com/package/@zpi-dev/desktop)
- [仓库](https://github.com/1316151417/zpi)

快速对话是独立的 [zpi-quick-chat](https://github.com/1316151417/zpi-quick-chat) CLI 项目，设置 `DEEPSEEK_API_KEY` 后通过 `npx @zpi-dev/quick-chat` 启动，需要 Node.js 24 和 Apple Silicon Mac。后端与 ZPI 共用 `@zpi-dev/agent-sdk`，可通过 `npm install @zpi-dev/agent-sdk` 接入自己的项目。Agent SDK 保持跨平台，包含 Windows 支持，不受桌面端的平台限制。SDK 使用和支持范围见 [agent-sdk](packages/agent-sdk/README.md)。
