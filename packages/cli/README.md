# zpi CLI

在终端里对当前目录使用 zpi 的模型和 read、edit、write、bash 工具。需要 Node.js 24。

## 连接模型

启动后输入 `/login`，或运行 `zpi auth login`，选择提供商和凭据。登录后用 `/model` 搜索该提供商的模型。Enter 切换本次会话，Ctrl+S 设为以后新会话的默认模型。公司网关与本地服务可选 OpenAI Chat Completions、OpenAI Responses 或 Anthropic Messages。没有模型目录的网关可以手填模型 ID。

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

输入 `/` 即可浏览命令和已发现的 Skill。输入 `/<Skill 名> 要求` 或用 Tab 补全后提交，会把该 Skill 加入本轮。Skill 与命令同名时，列表会显示 `/$名称`。也可以用 `/skills` 为下一条消息预选 Skill。

用 `@` 引用文件，`/help` 或空输入框中的 `?` 查看快捷键。Ctrl+O 展开思考内容和工具结果。底栏显示模型和已选推理档位，实际启用加速时显示「加速」。

会话按当前目录保存在 `~/.zpi/cli/`。普通 `-p` 使用临时会话，显式续聊才追加历史。切换账户后，续聊仍绑定原账户。若要改绑，可以用 `zpi -c -m <provider/model>`。打印模式的 stdout 只包含本轮结果，诊断写到 stderr。

## 从源码运行

在仓库根目录使用以下命令。构建后的 npm 包自带运行时，可以单独安装使用。

```sh
npm ci
npm run build --workspace=@zpi-dev/cli
./node_modules/.bin/zpi --help
npm pack --workspace=@zpi-dev/cli
```
