# 实现顺序与验收

实现以三项用户任务为单位。对应场景通过即可交付，下面的测试覆盖完整范围。已经从范围中移出的功能不计为未完成工作。

| 顺序 | 交付内容 | 完成条件 |
| --- | --- | --- |
| 1 · 从目录或管道调用 zpi | 新增 CLI 包和 bin，接原生会话、四个基础工具和公共指令。用 `auth login` 连接一个 API 服务，用 `models` 列出模型、`-m` 选用。接 `-p`、按目录的历史、`-c/-r` 和写锁。 | 从真实 bin 配置一个测试服务，完成读、改、运行命令。退出后可续聊，普通管道输出回答且不增加历史。 |
| 2 · 在终端完成短任务 | 使用 pi-tui 的编辑器、Markdown 和选择列表。接基本键位、工具详情、文件或图片引用、模型及推理选择、原生压缩、显式 Skill 和文件命令。 | 用户全程用键盘完成“选文件 → 输入中文多行问题 → 看工具结果 → 中断或继续”。帮助、补全和实际可执行项一致。 |
| 3 · 验证多账户、独立订阅及安装包 | 补齐 `auth list/switch/logout`、多协议模型发现、订阅 OAuth 和系统凭据存储。从发布包验证服务及账户选择。 | 同一测试账号两端获发不同 OAuth 应用 ID。CLI 可在订阅与 API 账户间显式切换，退出 CLI 授权后 Desktop 仍能调用。干净安装无需桌面二进制或源码树。 |

第一步通过 `zpi auth login` 连接本地假服务，完整交付包括第三步的订阅验收。终端取消、并发续写及凭据轮转分别用下面的场景验证。

## 验收场景

| 场景 | 通过标准 |
| --- | --- |
| 同目录续聊 | 从目录 A 提交后可 `-c` 和 `-r <id>`，目录 B 看不到 A 的记录。符号链接与实际路径归同一目录。只打开输入框、看帮助、选择模型后退出都不新增历史。 |
| 临时调用 | 连续 100 次普通 `-p`，CLI 可恢复会话数不变，正常完成后无残留工具快照。工作区中按要求完成的改动仍在。`-c -p` 则在原会话多出一轮。 |
| 并发与故障 | 两个不同 ID 可并行。同一 ID 只有持锁者能够打开或修复文件。终止写者后可以恢复，预览不改写历史，已执行的 shell 操作不自动重放。 |
| 配置复用与数据隔离 | 在临时 home 和工作区放置 AGENTS.md、同名 Skills、命令与禁用文件。验证来源、覆盖及显式选择。将模拟桌面私库设为不可访问，CLI 仍能正常工作。CLI 对公共配置的读取不改写文件。真实工具按用户任务修改项目文件时单独断言。 |
| 多服务、多模型与协议 | 从 bin 配置三个假服务，分别接受 OpenAI Chat Completions、OpenAI Responses 和 Anthropic Messages。一个网关启用两个模型，另一个服务配置同名模型。用 `zpi models` 与 `-m` 验证实际 URL、协议、模型 ID 和凭据归属。另测网关缺少模型目录时手填 ID。 |
| 账户与计费 | 同时连接 OpenAI 订阅和 API key，为 Anthropic 建 personal/work 两个账户。用 `auth list` 查看、`auth switch anthropic work` 切换、`models --default` 设默认。新会话用活动账户，已有会话续聊仍绑定原账户，`-c -m` 可显式改绑。订阅过期不产生 API key 请求，退出一个账户保留其他连接。 |
| 范围收敛 | 默认安装时 `/commit`、`/review`、`/summary` 不出现在帮助与补全，输入时也不向模型提交。自然语言问题仍可正常执行。工具直接执行，中途无需审批或计划模式切换。 |
| 终端与输出 | 用真实 PTY 验证粘贴、中文、窗口缩放、选择器焦点、取消和终端回显恢复。验证管道的 stdin、stdout、stderr、退出码与提前关闭。连续打印一轮回答和一次 `/compact` 时结果各自对应本轮。 |
| 独立登录 | 测试首次授权、原注册重授权、取消、错误 audience、过期刷新和并发轮转。分别验证实际应用 ID、模型请求与单端撤销。测试使用专用账号，凭据不进入会话、终端输出或测试报告。详见[授权验收](resources.md)。 |
| 改动与发包 | CLI 变更限于 `packages/cli/`、根 npm 锁文件和规划。现有内核、SDK、插件和 Desktop 源码、导出、构建脚本均不因 CLI 调整。保留工作区实施前已有的差异。 |

## 从发布包验证

沿用仓库的 Node 24，首批验收 macOS 和 Linux。包内提供 `bin.zpi`、ESM 构建和 PTY 测试入口。构建时收录用到的 workspace 代码及许可说明，原生依赖按 CLI 包自己的 npm 依赖安装。测试覆盖基于假 provider 的实际文件操作、CLI 自有目录和真实终端。运行时不依赖 Electron、桌面 IPC 或 Bun。[仓库声明](../../package.json) · [构建参考](../../scripts/build-agent-sdk.mjs) · [测试配置](../../vitest.config.ts)

以下命令用于实现后的验收。最后在临时空项目中安装生成的 tarball，从该项目自己的 `node_modules/.bin/zpi` 验证帮助、打印和交互续聊。

```sh
npm run check
npm run test:unit -- --project node packages/cli/test
npm run build --workspace=@zpi-dev/cli
npm run test:pty --workspace=@zpi-dev/cli
pack_dir="$(mktemp -d)"
npm pack --workspace=@zpi-dev/cli --pack-destination "$pack_dir"
```

## cli-dev 验收记录

本轮从 `main` 的 `82698b1` 建立分支。CLI 实现、测试与打包入口都在 `packages/cli/`。两个平台安装和测试的是同一份 `@zpi-dev/cli@0.1.0` tarball，SHA-256 为 `456b7622e3321ce6e5cfce39f87cc6c9300ba10a9065ec079568373dfb41966a`。

| 项目 | 实测结果 |
| --- | --- |
| 仓库检查与 CLI 单测 | `npm run check` 通过，CLI 的 5 个测试文件共 36 项通过。 |
| 独立安装 | 在 macOS 和 Ubuntu 24.04.5 arm64 的空项目安装 tarball，用各自的 `node_modules/.bin/zpi` 通过真实终端套件。两端均使用 Node 24.12.0。 |
| 终端与管道 | 通过真实服务连接向导配置三个本地协议端点，从实际请求验证模型、路径和凭据。读、写、编辑和 shell 实际改变了测试工作区的文件。另验证了中文多行输入、文件选择、中断、终端回显恢复、并发锁、续聊账户绑定、提前关闭管道及每个平台 100 次临时进程的清理。 |
| 系统密钥库 | macOS Keychain 测试条目完成写入、读取与删除。Ubuntu 在私有 D-Bus 会话中通过 `zpi auth login`、模型调用和 `auth logout` 验证 Secret Service。关闭密钥库后仍可显式绑定环境变量调用。 |
| 真实 ChatGPT 订阅 | 待专用账号完成两次浏览器授权。模拟身份服务已验证实际 OAuth 代码路径、两侧主体与签发 ID 的断言、调用顺序及单端撤销。真实服务签发结果以[专用账号验收脚本](resources.md#运行真实订阅验收)为准。 |
| 全仓回归 | 全仓单测有 6 个 Desktop 测试文件失败，已在单独解出的 `82698b1` 上逐项复现同样的失败。四个 preload 测试缺少 `document`，一个测试的 macOS mock 缺少 `registerDefaults`，另一个测试的模型显示名预期与主线实现不符。 |

验证其他发布包时，把 `ZPI_TEST_BIN` 设为临时项目中已安装可执行文件的绝对路径，在仓库根目录运行 `npm run test:pty --workspace=@zpi-dev/cli`。套件使用临时 home、本地服务和生成的测试账户。
