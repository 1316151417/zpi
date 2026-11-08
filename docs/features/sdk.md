# 在 TypeScript 中使用 Agent SDK

公开入口是 `@zpi-dev/agent-sdk`，ZPI 桌面和独立的 `zpi-quick-chat` 使用同一套查询执行协议。支持范围按 [Claude Agent SDK TypeScript reference](https://code.claude.com/docs/zh-CN/agent-sdk/typescript) 对齐，运行引擎仍由 ZPI 实现。

## 发起查询

```ts
import { query } from "@zpi-dev/agent-sdk";

for await (const message of query({
  prompt: "阅读 package.json 并说明这个项目的入口",
  options: {
    model: "deepseek",
    cwd: "/absolute/project",
    tools: ["Read"],
    allowedTools: ["Read"],
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

支持字符串和异步用户消息流、标准消息协议、会话恢复/分叉、模型和思考控制、Hook 回调、Agent 定义、本地插件、JSON schema 输出校验、用量统计和文件检查点。完整接口、示例和限制见 [SDK 包说明](../../packages/agent-sdk/README.md)。Node.js 24 必需。

SDK 不实现权限模式、MCP、LSP、插件 UI、市场、远程会话和 Claude Code 的企业/账户服务。不支持的接口明确报错。`claude_code` 提示预设使用 ZPI 的编码提示词，不能复制 Anthropic 的专有提示词。环境变量预置模型价格为零；需要金额预算时显式提供模型价格。

## 极简自定义工具示例

仓库中的 [examples/agent-sdk.ts](../../examples/agent-sdk.ts) 使用 `query()` 和 `defineTool()` 查询演示订单。工具参数从 TypeBox schema 自动推导，返回的 JSON 对象由 SDK 包装为文本结果；`persistSession: false` 让会话仅保存在内存中。

```ts
import { defineTool } from "@zpi-dev/agent-sdk";
import { Type } from "typebox";

const lookupOrder = defineTool({
  name: "lookup_order",
  description: "查询演示订单的状态",
  parameters: Type.Object({ orderId: Type.String() }),
  execute({ orderId }) {
    return { orderId, status: "已发货" };
  },
});
```

在仓库根目录设置 `DEEPSEEK_API_KEY` 后运行：

```sh
npm run example:sdk
```

示例使用真实 DeepSeek 模型，订单状态是工具返回的固定演示数据。

## 工具与插件边界

公共 `query` 提供 `Read`、`Write`、`Edit`、`Bash` 和任务控制工具；有相应技能或 Agent 定义时再装配 `Skill`、`Agent`。`Bash.timeout` 使用毫秒，`run_in_background` 由 SDK 的任务管理器执行。底层原生会话的四个小写工具与桌面后台命令插件有各自参数和生命周期，参见[工具接口区别](tools.md#命令工具的接口区别)。

`Glob`、`Grep` 暂不支持，仅保留工具名称、参数 schema 和占位定义，调用会抛出 `Error("暂不支持")`。`Skill`、`TaskOutput`、`TaskStop` 使用 `defineTool()` 包装文本或 JSON 结果，继续复用原生工具执行流程。

应用显式选择工具、资源、插件和 Hook。公共 SDK 不自动装配 ZPI 桌面的七类系统运行时插件，也不包含桌面工作区界面。桌面通过宿主接口装配这些插件；它们的默认值、配置和外部插件兼容范围见[插件](plugins.md)。独立的 [zpi-quick-chat](https://github.com/1316151417/zpi-quick-chat) 只使用自身所需的 SDK 能力。

## 构建与原生宿主

构建独立包：

```sh
npm run build:sdk
npm pack --workspace @zpi-dev/agent-sdk
```

原生宿主可从 `@zpi-dev/agent-sdk/host` 获取 `createAgentSession`，注入索引存储、模型运行时和插件，再用 `query` 驱动会话。宿主负责平台服务与事件订阅；ZPI 将七类插件服务的构造、策略、恢复与清理交给独立的 `BuiltinPluginRuntime`，通过通用接口接入模型、存储与通知。底层 `@zpi-dev/coding-agent` 是内部引擎，不再作为应用默认接入入口。内核装配机制见 [SDK 装配](../internals/sdk.md)。
