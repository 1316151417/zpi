# zpi CLI

在终端里对当前目录使用 zpi 的模型和 read、edit、write、bash 工具。需要 Node.js 24。

## 连接模型

第一次运行 `zpi auth login`，选择服务、凭据来源、要启用的模型和默认模型。公司网关与本地服务可选 OpenAI Chat Completions、OpenAI Responses 或 Anthropic Messages。没有模型目录的网关可以手填模型 ID。

```sh
zpi auth login openai --method oauth
zpi auth login anthropic --method key
zpi auth list
zpi auth switch anthropic work
zpi models
zpi models --default team/coder
zpi auth logout
```

ChatGPT 订阅需单独为 CLI 授权。可以为同一服务连接多个账户，例如分别命名为 `personal` 和 `work`。API key 和订阅令牌保存在 macOS Keychain 或 Linux Secret Service。无桌面密钥库的环境可显式绑定 API key 的环境变量。本地 OpenAI 兼容服务也可以选择无密钥。

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

交互中用 `/help` 查看命令，`@` 选择文件，Ctrl+J 换行，Ctrl+O 展开工具详情，Esc 中断当前轮，空输入时 Ctrl+D 退出。可以用 `/skills` 为下一条消息选择工作区或用户的 Skill。

会话按当前目录保存在 `~/.zpi/cli/`。普通 `-p` 使用临时会话，显式续聊才追加历史。切换账户后，续聊仍绑定原账户。若要改绑，可以用 `zpi -c -m <provider/model>`。打印模式的 stdout 只包含本轮结果，诊断写到 stderr。

## 从源码运行

在仓库根目录使用以下命令。构建后的 npm 包自带运行时，可以单独安装使用。

```sh
npm ci
npm run build --workspace=@zpi-dev/cli
./node_modules/.bin/zpi --help
npm pack --workspace=@zpi-dev/cli
```
