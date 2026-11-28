# zpi CLI

在终端里对当前目录使用 zpi 的模型和 read、edit、write、bash 工具。需要 Node.js 24。

## 连接模型

启动后输入 `/login`，或运行 `zpi auth login`，选择提供商和凭据。登录后用 `/model` 搜索该提供商的模型。Enter 切换本次会话，Ctrl+S 设为以后新会话的默认模型。公司网关与本地服务可选 OpenAI Chat Completions、OpenAI Responses 或 Anthropic Messages。网关没有模型目录时，逐项填写模型 ID 和长度上限，再勾选模型接受的推理档位。留空时只提供 `off`。

```sh
zpi auth login openai --method oauth
zpi auth login anthropic --method key
zpi auth list
zpi auth switch anthropic work
zpi models
zpi models --default team/coder
zpi auth logout
```

ChatGPT 订阅需单独为 CLI 授权。普通登录无需填写账户名称。只有同一提供商需要第二套凭据时才使用 `auth login <provider> --account work`。API key 和订阅令牌保存在 macOS Keychain 或 Linux Secret Service。无桌面密钥库的环境可显式绑定 API key 的环境变量。本地 OpenAI 兼容服务也可以选择无密钥。

## 使用

```sh
zpi
zpi "解释这个目录的入口"
zpi -m team/coder "读取 README 并修正示例"
git diff | zpi -p "说明此次改动"
zpi -c
zpi -r
zpi -r <id> -p "上一步改了哪些文件？"
```

启动时，屏幕左上角只显示黄色的 `ZPI`。输入框固定在底部，下方显示当前目录、用量和模型状态。

输入 `/` 浏览命令和 Skill。可直接键入 `/<Skill 名> 要求`，也可以用 Tab 补全，或从 `/skills` 选择。完整名称会在输入框中高亮，按 Enter 后才调用。Skill 与命令同名时使用列表显示的 `/$名称`。带参命令在输入时提示用法，例如 `/rename <会话名称>` 可以在首条消息发送前给会话命名。

用 `@` 引用文件。`/help` 或空输入框中的 `?` 打开快捷键和命令帮助，Esc 关闭。`/hotkeys` 在当前对话的滚动区列出键位。模型返回可读思考时默认直接显示，Ctrl+T 可隐藏或展开，CLI 会记住选择。Ctrl+O 展开或收起工具输出。用 `/effort` 或 Shift+Tab 调整模型的推理强度。

会话按当前目录保存在 `~/.zpi/cli/`。普通 `-p` 使用临时会话，显式续聊才追加历史。切换账户后，续聊仍绑定原账户。若要改绑，可以用 `zpi -c -m <provider/model>`。打印模式的 stdout 只包含本轮结果，诊断写到 stderr。

## 从源码运行

在仓库根目录使用以下命令。构建后的 npm 包自带运行时，可以单独安装使用。

```sh
npm ci
npm run build --workspace=@zpi-dev/cli
./node_modules/.bin/zpi --help
npm pack --workspace=@zpi-dev/cli
```
