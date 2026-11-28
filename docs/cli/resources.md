# 公共资源与订阅授权

模型连接、账户和默认模型由 CLI 独立管理，详见[模型配置与账户](models.md)。此处列出两端共用的资源文件和 CLI 订阅授权的实现要求。

## 两端仍共用的工作区资源

| 来源 | CLI 的读取方式 |
| --- | --- |
| 项目说明 | 原生 `FileResourceLoader` 读取用户的 `~/.agents/AGENTS.md`、`~/.zpi/AGENTS.md` 和当前目录的 `AGENTS.md`、`.zpi/AGENTS.md`。编辑同一文件后，两端都能使用。 |
| 运行设置 | 交给 `SettingsManager` 读取工作区 `.zpi/settings.json`，沿用原生重试、压缩等设置。 |
| Skills | 复用用户和当前工作区的 `.agents/skills`、`.zpi/skills` 及原有同名优先级。`/` 菜单列出可用 Skill。直接输入 `/<名称> [要求]`，或用 `/skills` 把选中名称填回编辑框。完整名称行内高亮，提交时才把对应正文加入请求。 |
| 文件命令 | 用户和当前目录的 `.zpi/commands`、同级 `.zpi/command-state.json` 是公共文件。CLI 提供现有提示模板的调用入口，创建和管理仍在 Desktop。 |

CLI 不打开 Desktop 的私有数据库或 `credentials.enc`。两端各自的会话和模型管理都独立于上表中的公共文件。[原生资源发现](../../packages/coding-agent/src/core/resources.ts) · [运行设置](../../packages/coding-agent/src/core/settings-manager.ts) · [桌面私有设置](../../packages/desktop/src/main/storage.ts)

## 文件命令的实现上限

共用已有的纯 Node 文件读取与模板展开代码。CLI 包在构建时只接入 `CustomCommandsStore.list`、已有导入链接的只读校验和模板解析函数，不启动 Electron，也不调用导入、写配置或桌面 IPC。项目命令优先于用户命令，同名忽略大小写。已禁用的项目命令遮蔽同名用户命令。禁用文件损坏、链接缺少现有登记或命令文件在准备时变更，均停止此次调用并说明来源。[文件读取](../../packages/desktop/src/main/custom-commands.ts) · [导入链接登记](../../packages/desktop/src/main/command-import.ts)

可执行范围是静态提示模板、原有位置参数及显式声明的 Skill。用 `prepareCustomCommandPrompt` 对原模板分段，只在整条命令满足条件时向模型提交一次。含动态 shell 段的模板在执行前直接提示“此命令需要桌面端”。`disable-noninteractive` 在 `-p` 下生效。内置命令名优先。默认安装不附送业务模板，也不为同名用户文件增加特例。[参数与模板分段](../../packages/desktop/src/main/custom-command-expansion.ts)

## 独立的 ChatGPT 订阅授权

CLI 通过 `zpi auth login openai --method oauth` 独立授权，Desktop 无需运行。用户可以用同一 ChatGPT 账号。两端各自持有服务方签发的 OAuth 应用 ID 和凭据。`zpi auth list` 展示 CLI 自身连接。退出时只撤销用户选定的 CLI 授权。此处的应用 ID 指**授权服务签发的 `client_id`**。本地生成的安装 UUID、密钥库名称及浏览器显示名各有其他用途。

1. **首次登录。** 在 CLI 自有目录创建并持久保存本安装的 `ext_agent_host_id`（`urn:uuid:<UUIDv4>`），调用现有 `beginChatGPTLogin({ hostId })`。首次请求按服务协议使用 `dynamic_agent_client` 开始动态注册。现有 helper 把首次展示名设为 `ZPI`，CLI 在打开它返回的授权 URL 前只将 `agent_name_hint` 设为 `ZPI CLI`，保留原回调地址、state、nonce 和 PKCE。这个显示名方便用户识别授权。没有本地浏览器时可显示授权链接，并用 helper 现有的 `submitCallback` 接收返回地址。回调内容不写日志。
2. **取得实际应用 ID。** 接受 CLI 此次回调返回的专属 `client_id`，沿用现有 helper 以它换取令牌、验证身份令牌的 audience 和账号、检查订阅授权范围。只有验证通过才能保存和用模型。首次注册入口名和安装 ID 都不能当成签发的 ID。以后同一注册的重授权、刷新和撤销均使用 CLI 自己的签发 ID。重授权仅向 helper 传入 CLI 保存的注册资料。[现有 OAuth 实现](../../packages/ai/src/auth/openai-chatgpt.ts) · [OpenAI 注册与登录协议](https://developers.openai.com/siwc/token-sharing-open-source/sign-in)
3. **保管与调用。** 在 macOS Keychain 或 Linux Secret Service 使用 CLI 专用条目保管凭据，并在 CLI 的进程间串行处理刷新和退出。刷新时持锁重读。现有 `saveRotation` 回调是同步的，所接密钥库适配必须在返回前完成持久化。身份验证成功后保存最终状态。进程若中途退出，下次先验证 `identityPending` 的凭据，再发模型请求。通过 CLI 授权发现订阅账号可用模型，用现有 `openai-chatgpt` 预设注册 `ModelRuntime`。交互与 `-p` 复用同一条模型注册和调用路径。密钥库不可用时明确说明订阅登录不可用。显式绑定环境变量的 API 服务仍可独立使用。[现有模型发现](../../packages/ai/src/providers/discovery.ts) · [桌面端行为对照](../../packages/desktop/src/main/chatgpt-auth.ts)
4. **证明两端独立。** 用同一测试账号和工作区分别授权 Desktop 与 CLI，在各自受控的测试回调中核对两个实际签发的 `client_id` 不同，再分别进行一次订阅模型调用。退出并撤销 CLI 授权后，Desktop 仍可调用。生产 CLI 不为这个比较读取桌面数据库、凭据或真实用户的登录日志。模拟服务的测试验证协议，真实授权的发版验收才验证服务方实际发出了不同 ID。若 ID 相同，该项未通过。[现有登录测试](../../packages/desktop/test/chatgpt-auth.test.ts)

### 运行真实订阅验收

在仓库根目录安装依赖后，用 Node 24 在终端显式启动。请使用专用测试账号。脚本会依次打开 Desktop 和 CLI 授权页面，请在两次授权中选择同一个账号。

```sh
node packages/cli/test/subscription-live.ts --dedicated-test-account
```

脚本在临时目录创建两套全新安装的状态，使用 Desktop 主进程的 `ChatGPTAuth`、`SettingsStore` 和 CLI 的 `Accounts`，分别接收本机回调。两侧 token 只存本进程内存。脚本核对已签名的账号主体和实际应用 ID，选择两个账号都列出的同一模型，依次用 Desktop 和 CLI 发起短请求，撤销本次 CLI 授权后再以 Desktop 发起第三次请求。结束时清理本次 Desktop 测试授权和临时状态。终端只报告步骤和结果。任一步未通过都返回非零退出码。常规单测用模拟授权方验证同一流程，真实服务的发行验收需要上述人工授权。[验收入口](../../packages/cli/test/subscription-live.ts) · [模拟协议测试](../../packages/cli/test/subscription-acceptance.test.ts)
