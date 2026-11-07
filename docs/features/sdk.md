# 在 TypeScript 中使用 Agent SDK

公开入口是 `zpi-agent-sdk`，ZPI 桌面和独立的 `zpi-quick-chat` 使用同一套查询执行协议。支持范围按 [Claude Agent SDK TypeScript reference](https://code.claude.com/docs/zh-CN/agent-sdk/typescript) 对齐，运行引擎仍由 ZPI 实现。

```ts
import { query } from "zpi-agent-sdk";

for await (const message of query({
  prompt: "说明这个项目的入口",
  options: {
    model: "deepseek",
    cwd: "/absolute/project",
    tools: ["Read", "Glob", "Grep"],
    allowedTools: ["Read", "Glob", "Grep"],
    maxTurns: 8,
    includePartialMessages: true,
  },
})) {
  if (message.type === "result" && message.subtype === "success") {
    console.log(message.result);
  }
}
```

配置 `DEEPSEEK_API_KEY` 后可使用该例。`tools` 选择模型可见的工具，`allowedTools` 自动批准匹配调用，`disallowedTools` 拒绝调用。未预批准的调用交给 `canUseTool`；未设置回调时直接执行。纯文本和图片对话使用 `tools: []`。

支持字符串和异步用户消息流、标准消息协议、会话恢复/分叉、模型和思考控制、Hook 回调、Agent 定义、本地插件、JSON schema 输出校验、用量统计和文件检查点。完整接口、示例和限制见 [SDK 包说明](../../packages/agent-sdk/README.md)。Node.js 24 必需，Grep 需要 PATH 中存在 `rg`。

SDK 不实现权限模式、MCP、LSP、插件 UI、市场、远程会话和 Claude Code 的企业/账户服务。高级能力不提供空实现。`claude_code` 提示预设使用 ZPI 的编码提示词，不能复制 Anthropic 的专有提示词。环境变量预置模型价格为零；需要金额预算时显式提供模型价格。

构建独立包：

```sh
npm run build:sdk
npm pack --workspace zpi-agent-sdk
```

原生宿主可从 `zpi-agent-sdk/host` 获取 `createAgentSession`，注入索引存储、模型运行时和插件，再用 `query` 驱动会话。宿主保留服务生命周期与事件订阅。底层 `zpi-coding-agent` 是内部引擎，不再作为应用默认接入入口。内核装配机制见 [SDK 装配](../internals/sdk.md)。
