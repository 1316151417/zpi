# 实现顺序与验收

实现以三项用户任务为单位。对应场景通过即可交付，下面的测试覆盖完整范围。已经从范围中移出的功能不计为未完成工作。

| 顺序 | 交付内容 | 完成条件 |
| --- | --- | --- |
| 1 · 从目录或管道调用 zpi | 新增 CLI 包和 bin，接原生会话、四个基础工具和公共指令。用 `auth login` 连接一个 API 服务，用 `models` 列出模型、`-m` 选用。接 `-p`、按目录的历史、`-c/-r` 和写锁。 | 从真实 bin 配置一个测试服务，完成读、改、运行命令。退出后可续聊，普通管道输出回答且不增加历史。 |
| 2 · 在终端完成短任务 | 用 pi-tui 的全屏布局、编辑器、Markdown 和选择列表呈现对话。接工具详情、思考显示、文件或图片引用、选模、原生压缩、显式 Skill 和文件命令。 | 用户全程用键盘选择文件、输入中文多行问题、查看工具并继续。命令帮助可关闭，Skill 在 `/` 候选和编辑行中可见。 |
| 3 · 验证多账户、独立订阅及安装包 | 补齐 `auth list/switch/logout`、多协议模型发现、订阅 OAuth 和系统凭据存储。从发布包验证服务及账户选择。 | 模拟授权服务覆盖应用 ID 核对和单端撤销。CLI 可在订阅与 API 账户间显式切换。干净安装无需桌面二进制或源码树。 |

第一步通过 `zpi auth login` 连接本地假服务。本次交付的订阅验收采用模拟身份服务，专用账号的真实授权为可选检查。

## 验收场景

| 场景 | 通过标准 |
| --- | --- |
| 同目录续聊 | 从目录 A 提交后可 `-c` 和 `-r <id>`，目录 B 看不到 A 的记录。符号链接与实际路径归同一目录。只打开输入框、看帮助、选择模型后退出都不新增历史。 |
| 临时调用 | 连续 100 次普通 `-p`，CLI 可恢复会话数不变，正常完成后无残留工具快照。工作区中按要求完成的改动仍在。`-c -p` 则在原会话多出一轮。 |
| 并发与故障 | 两个不同 ID 可并行。同一 ID 只有持锁者能够打开或修复文件。终止写者后可以恢复，预览不改写历史，已执行的 shell 操作不自动重放。 |
| 配置复用与数据隔离 | 在临时 home 和工作区放置 AGENTS.md、同名 Skills、命令与禁用文件。验证来源、覆盖及显式选择。将模拟桌面私库设为不可访问，CLI 仍能正常工作。CLI 对公共配置的读取不改写文件。真实工具按用户任务修改项目文件时单独断言。 |
| 多服务、多模型与协议 | 从 bin 配置接受三种协议的本地服务，核对实际 URL、协议、模型 ID 和凭据。对缺少模型目录的网关，手填模型并勾选档位，核对 `--effort high` 发出的请求。 |
| 账户与计费 | 同时连接 OpenAI 订阅和 API key，为 Anthropic 建 personal/work 两个账户。用 `auth list` 查看、`auth switch anthropic work` 切换、`models --default` 设默认。新会话用活动账户，已有会话续聊仍绑定原账户，`-c -m` 可显式改绑。订阅过期不产生 API key 请求，退出一个账户保留其他连接。 |
| 范围收敛 | 默认安装时 `/commit`、`/review`、`/summary` 不出现在帮助与补全，输入时也不向模型提交。自然语言问题仍可正常执行。工具直接执行，中途无需审批或计划模式切换。 |
| 终端与输出 | 用真实 PTY 核对输入框固定在底部、窗口缩放、粘贴、中文、选择器焦点、取消和终端恢复。以协议事件分别检验可见思考、正文、工具的显示顺序，以及 Ctrl+T 与 Ctrl+O 的独立作用。验证管道的 stdin、stdout、stderr、退出码与提前关闭。 |
| 独立登录 | 模拟身份服务覆盖首次授权、原注册重授权、取消、错误 audience、过期刷新、并发轮转和单端撤销。如需核对 OpenAI 实际签发的应用 ID，可使用专用账号运行[授权验收](resources.md)。 |
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
| 真实 ChatGPT 订阅 | 按本次交付决定免测。模拟身份服务已验证 OAuth 代码路径、两侧主体与签发 ID 的断言、调用顺序及单端撤销。[可选的专用账号验收脚本](resources.md#运行真实订阅验收) |
| 全仓回归 | 全仓单测有 6 个 Desktop 测试文件失败，已在单独解出的 `82698b1` 上逐项复现同样的失败。四个 preload 测试缺少 `document`，一个测试的 macOS mock 缺少 `registerDefaults`，另一个测试的模型显示名预期与主线实现不符。 |

验证其他发布包时，把 `ZPI_TEST_BIN` 设为临时项目中已安装可执行文件的绝对路径，在仓库根目录运行 `npm run test:pty --workspace=@zpi-dev/cli`。套件使用临时 home、本地服务和生成的测试账户。
