# 模型配置与账户

模型配置完全由 CLI 管理。Desktop 里手工添加的模型、地址、API key 和订阅授权不会自动导入。需要使用同一 API 服务时，可以在 CLI 再填一次已有的 key。ChatGPT 订阅则使用 CLI 自己的 OAuth 应用注册。所有设置都通过终端完成。

## 命令与操作

```sh
zpi auth login                        # 选择提供商和凭据
zpi auth login openai --method oauth  # 用 ChatGPT 订阅授权
zpi auth login openai --method key    # 连接 OpenAI API 账户
zpi auth login anthropic --method key # 隐藏输入 Anthropic API key
zpi auth list                         # 查看已连接账户和各服务的当前账户
zpi auth switch anthropic work        # 激活已保存的 work 账户
zpi auth logout                       # 选择要移除的本地连接
zpi models                            # 列出当前账户可选的 provider/model
zpi -m team/coder -p "说明当前目录的用途"
```

`zpi auth` 与 `zpi auth login` 打开同一选择器。交互内可用 `/login` 或 `/login anthropic`。普通登录直接连接提供商，服务返回的可用模型自动进入目录。只有需要在同一提供商下另存凭据时才使用 `--account work`；已有命名账户继续有效。第二次添加账户时保留原连接，首次成功登录的账户成为该服务的当前账户，之后用 `switch` 明确切换。取消登录或验证失败都保留原连接。

| 添加的服务 | 用户提供什么 | 模型从哪里来 |
| --- | --- | --- |
| OpenAI · ChatGPT 订阅 | `openai --method oauth` 打开浏览器，同意 CLI 的订阅授权 | 从该账号发现可用模型。订阅仅用账号实际列出且标为 `listed` 的模型。预设补充的 `unverified` 条目不能证明账号有权限。 |
| OpenAI · API | `openai --method key` 输入 API key | 通过 OpenAI API 账户和 zpi 的 `openai-api` 预设发现模型。它与订阅是两个独立账户，可以同时保存。 |
| Anthropic、DeepSeek 等 API 服务 | 选内置服务名，隐藏输入 key，或显式指定由哪个环境变量提供 key | CLI 的 `anthropic` 入口直接走已有 Anthropic Messages 适配和官方地址。DeepSeek、智谱、MiniMax、MiMo 等复用 zpi 自带的预设、地址和模型元数据。 |
| 公司网关或本地服务 | 选“自定义”，输入短服务名、协议、Base URL 和密钥来源 | 从服务自动发现多个模型。缺少目录时，为每项填写 ID、上下文上限和输出上限，按空格勾选该模型接受的推理档位。例如 `team/coder` 和 `team/writer` 可以属于同一条连接。 |

自定义服务支持 **OpenAI Chat Completions、OpenAI Responses 和 Anthropic Messages**，分别对应 `openai-completions`、`openai-responses`、`anthropic-messages`。一个服务名绑定一个地址和协议，同一网关提供两种协议时可保存为两个服务名。支持无认证的 OpenAI 兼容本地服务可显式选择“无密钥”。绑定了环境变量但变量缺失时提示补齐。仅仅在 shell 里设置一个 key 不会自动新增服务。[协议](../../packages/ai/src/types.ts) · [公共预设](../../packages/ai/src/providers/registry.ts) · [模型发现](../../packages/ai/src/providers/discovery.ts) · [原生 OpenAI 兼容请求](../../packages/ai/src/api/openai-completions.ts) · [既有 Anthropic 接入](../../packages/agent-sdk/src/runtime.ts)

手填模型的推理档位可留空，此时 `/effort` 只提供 `off`。例如网关为 `coder` 声明 `medium` 和 `high`，在向导里勾选这两项后即可使用 `zpi -m team/coder --effort high`。重新连接同协议的服务时，向导按模型 ID 回填设置。若网关的目录只返回陌生的模型 ID，CLI 沿用内核发现的保守能力。推理强度决定请求参数，Ctrl+T 只改变已有可见推理的显示。

## 订阅与 API 共存

Codex 的 `model_provider` 和 `model` 用于选择服务和模型，服务可以声明自己的 `env_key`，ChatGPT 登录凭据由认证存储管理。zpi 借用服务选择与认证分开的做法。用户通过上述命令配置服务，终端按账号实际授权调用 zpi 已有的模型协议。[Codex 服务配置](https://developers.openai.com/codex/config-advanced/) · [Codex 认证与凭据](https://developers.openai.com/codex/auth/)

**以 OpenAI 为例。** `zpi auth list` 可以同时列出 `openai personal · ChatGPT 订阅` 和 `openai work · API key`，并标记当前账户。对新调用，`zpi -m openai/<模型ID>` 使用当前 OpenAI 账户。`zpi models` 每行只输出一个 `provider/model`。凭据和计费方式见 `zpi auth list`，选择器里标记当前模型及新会话的默认模型。切到 `work` 才走该 API 账户，订阅登出、配额不足或模型不可用都不触发自动切换。

**接入内核。** CLI 按账户解析模型，再用现有 `ModelRuntime.registerProvider` 注册本次要用的服务。`openai + oauth` 对应原有 `openai-chatgpt` 预设，模型带 `auth: "chatgpt"`，通过 `getApiKey` 获取或刷新 CLI 订阅令牌。`openai + key` 对应 `openai-api`，直接使用该账户的 API key。两者均可走 Responses，但有各自的凭据、模型清单和计费来源。只有内置订阅路径能使用订阅令牌，订阅地址和请求头不能被自定义网关覆盖。服务别名和协议本身不会授予订阅权限。[原生模型运行时](../../packages/coding-agent/src/core/model-runtime.ts) · [现有订阅装配](../../packages/desktop/src/main/model-runtime-config.ts)

**账户生命周期。** 订阅首次授权采用 CLI 自己的安装标识和服务方签发的应用 ID。新增另一个账号时建立该账号自己的注册，重授权只使用对应账号已保存的资料。登录成功但模型发现失败时显示可重试状态。`auth logout` 选定一个连接后，OAuth 只撤销该 CLI 连接的授权，API key 只移除 CLI 保存的密钥或引用。在服务商处申请的 API key 和其他账户都不受影响。若移除的是当前账户，则提示选择另一个账户，不自动改走另一种计费来源。[独立订阅授权验收](resources.md)

## 选模、默认值与恢复

在交互内输入 `/model` 或按 Ctrl+L 打开可搜索的模型列表。`/model team/coder` 和唯一的完整模型 ID 会直接切换，关键词及歧义 ID 会打开预填搜索词的列表。Enter 选择本次模型，Ctrl+S 同时设为默认。Ctrl+P 和 Ctrl+Shift+P 在可用模型间前后切换。命令行使用 `-m` 或 `--model provider/model`。登录、默认值与临时选择的交互参照 [Pi 模型说明](https://github.com/earendil-works/pi/blob/2126569de40d5595dd3f41f7af126001f04c1de0/packages/coding-agent/docs/models.md)。

- `zpi models` 列出各服务当前账户启用的模型，`-m` 与 `--model` 是同一参数。服务名在 CLI 内唯一，按第一个斜杠拆分 `服务名/模型ID`，保留模型 ID 内的斜杠。使用未知名称时报错并提示查看 `zpi models`。
- 第一次成功启用一项模型即设为新会话默认，一次发现多项时先使用目录中的第一项。在 `/model` 中按 Ctrl+S，或用 `zpi models --default <服务名>/<模型ID>`，可更改以后新会话的默认值。新会话依次使用显式 `-m`、CLI 默认模型，在目标服务当前账户内解析。新增服务、恢复桌面或切换目录都不会覆盖 CLI 的默认值。
- 一个正在执行的请求沿用开始时选定的账户。续聊默认恢复该 CLI 会话保存的服务、模型和账户标识，切换全局账户不会改变旧会话的计费来源。要明确让旧会话使用该服务的新当前账号，可在 `zpi -c` 时附加 `-m`，或在交互中用 `/model` 指定。选择器内按 Enter 只更新本会话。原账户已移除、授权已失效或模型不可用时，给出原因和可用入口，普通 `-p` 不弹选择器。
- CLI 将服务名、协议、地址、已启用模型、账户标识、凭据引用和默认模型保存在自己的数据目录。API key 和订阅令牌存 CLI 专属系统密钥库，选择环境变量时只记变量名。帮助、账户列表、会话文件和日志均不含密钥。只有通过配置入口显式绑定的变量会被读取。项目文件不能改写服务端点，编辑网关地址需要重新绑定凭据。整个流程无需手写 JSON，也不读取 Codex 或 Desktop 的配置。
