# zpi CLI 实现规划

zpi Desktop 是主要工作入口。用户在终端可以把当前目录里的短任务交给 zpi，回来接着上次的 CLI 对话做，也可以把管道输入交给模型、把结果交还脚本。沿用 Claude Code 熟悉的输入方式，让桌面用户偶尔打开终端也会用。

## 五条产品原则

1. **由 CLI 适配已有 zpi。** 新增 `packages/cli/`，通过现有接口接入模型、会话和工具。内核、SDK、插件和 Desktop 均零改动。某项交互若需要为 CLI 新开内核接口或桌面服务，就从本方案中移出。
2. **以已有能力划定上限。** 一个内置命令必须能够指向现有 zpi 执行入口，或者解释它为什么是必要的终端操作。Claude Code 是交互参考。zpi 没有的 `/commit`、`/review`、`/summary` 不迁移命令、提示模板或配套代码。`/compact` 直接使用 zpi 已有的上下文压缩。
3. **沿用 zpi 的执行方式。** 用户提交任务后，模型调用与工具执行按内核已有语义进行。审批、权限模式、计划模式、MCP 和 workflow 不进入产品范围。模型遇到业务歧义时可以照常提问。
4. **模型和会话独立，工作区文件共用。** 用户通过 `zpi auth` 独立配置 CLI 的服务、账户和模型，CLI 不打开桌面数据库。ChatGPT 订阅使用与 Desktop 不同的实际 OAuth 应用 ID。CLI 历史按实际目录收在 `~/.zpi/cli/`。两端共用已有的 AGENTS.md、Skill 和命令文件及项目运行设置。
5. **桌面优先，让长尾入口保持轻量。** 内核支持一项能力，只说明它有资格进入候选。纳入 CLI 还要确实服务上述三个场景，并且能用很少的界面和状态完成。需要新建项目管理、后台调度或跨文件恢复机制的工作，继续由 Desktop 承担。

**新增功能时，先回答三个问题。** 哪个终端任务需要它？哪个已有 zpi 入口负责执行？为它新增的持久状态或管理界面是什么？例如工具行展示 edit 的已有差异可以直接服务当前任务，完整的 Git 变更浏览、历史回退和工作树管理则另需一套工作区生命周期。

## 对上一版规划的取舍

| 原规划中的设计 | 本版决定 |
| --- | --- |
| 交互如何验收 | 对范围内的操作，逐项对照 Claude Code 的呈现、按键、焦点、运行反馈和历史回放。模型配置按 Pi 的登录和选模流程验收。见[交互对照](parity.md)。 |
| 模型和账户如何配置 | `zpi auth login/list/switch/logout` 管理连接与当前账户，`zpi models` 列出启用的模型，`-m` 选本次模型。支持多服务、多模型和内核已有的三种协议。无需手写配置文件。 |
| 分支、文件回退、工作树、旁聊、任务面板及长期记忆整理 | 从 CLI 交付范围移除。部分能力在 zpi 或 Desktop 已有，但终端版完整体验需要第二套会话或任务宿主。 |
| 可恢复输入队列、全局状态索引、版本化流事件协议 | 使用进程内草稿、按目录的原生历史文件和纯文本管道。只保留避免两个进程同时破坏同一条历史的写锁。 |

## 从用户视角验收

```sh
cd ~/code/shop
zpi auth login openai --method oauth
zpi models
zpi "打开购物车实现，解释数量是如何更新的"
zpi -c
zpi -r
git diff | zpi -p "这次改动影响了什么？"
zpi -c -p "列出刚才的对话里还有哪些待验证的地方"
```

使用 API 服务时，在 `zpi auth login` 中选服务并绑定 API key。使用 ChatGPT 订阅时，桌面已登录的用户仍需首次单独授权 CLI，之后由 CLI 使用自己的注册。空启动和普通 `-p` 都不会增加历史，显式续聊会追加到原 CLI 会话。

## 实施文档

| 文档 | 内容 |
| --- | --- |
| [Claude Code 与 Pi 交互对照](parity.md) | 覆盖范围、已验证的终端行为、剩余差异和产品取舍。 |
| [终端交互](interaction.md) | CLI 调用、斜杠命令、按键、错误与打印契约。 |
| [会话执行与隔离](runtime.md) | 单一原生执行路径、按目录续聊、临时快照及跨进程写锁。 |
| [模型配置与账户](models.md) | 连接多个服务、多种协议和多个账户，列出模型、指定默认值，以及 OpenAI 订阅与 API 计费的选择规则。 |
| [公共资源与订阅授权](resources.md) | 哪些工作区文件可共用，以及独立订阅授权如何取得不同应用 ID。 |
| [实现顺序与验收](delivery.md) | 三步开发、真实终端测试、同账号双端授权验证和发包条件。 |

终端组件使用可复用的 pi-tui。行为对照优先使用可运行的 Claude 参考仓库，实际交付范围以上述五条原则为准。[Claude Code 交互说明](https://code.claude.com/docs/en/interactive-mode) · [可运行参考](https://github.com/claude-code-best/claude-code) · [旧版本快照](https://github.com/ChinaSiro/claude-code-sourcemap) · [pi-tui](https://github.com/earendil-works/pi/blob/main/packages/tui/README.md)
