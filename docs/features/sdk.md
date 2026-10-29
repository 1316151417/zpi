# 在脚本中使用 SDK

`zpi-coding-agent` 提供模型运行时、四个工具、会话和上下文管理，可在仓库脚本中使用。桌面提问、子智能体和后台任务由桌面扩展提供。

## 运行示例

按[开发步骤](development.md)安装依赖后执行：

```sh
npm run example:coding
```

[示例源码](../../examples/coding-session.ts)启动本地假模型服务，在临时目录演示 read/write/edit/bash、事件订阅、扩展工具和会话恢复，不需要线上模型凭据。示例会打印保存路径，结束时关闭会话和服务。

## 接入真实提供商

创建 `ModelRuntime`，调用 `registerProvider` 设置服务地址、认证和模型，再传入 `createAgentSession`。选择的模型必须已注册且有可用认证或自定义 stream；SDK 不自动读取桌面已保存账号。

```ts
import { createAgentSession, ModelRuntime, SessionManager } from "zpi-coding-agent";

const runtime = await ModelRuntime.create();
runtime.registerProvider("local", {
  baseUrl: "http://127.0.0.1:8000/v1",
  api: "openai-completions",
  apiKey: "",
  models: [{
    id: "your-model-id", name: "Local model", reasoning: false,
    input: ["text"], contextWindow: 32768, maxTokens: 4096,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  }],
});
const { session } = await createAgentSession({
  cwd: "/absolute/project",
  modelRuntime: runtime,
  sessionManager: SessionManager.inMemory("/absolute/project"),
});
try {
  await session.prompt("说明项目入口，先不修改文件。");
} finally {
  await session.abort();
  session.dispose();
}
```

地址、ID 和预算是示例配置，需替换为本地服务实际值。内存会话不写会话日志，但工具仍能写文件和运行命令。

## 扩展入口

| 选项 | 用途 |
| --- | --- |
| `customTools` | 新增工具名 |
| `toolOverrides` | 替换已存在的内置工具 |
| `customInstructions` | 追加文字数组，或资源刷新后求值的同步函数 |
| `resourceLoader` | 注入资源发现与指令加载 |
| `promptTemplate` | 定义基础提示模板 |
| `settingsManager` | 提供内存或文件运行设置 |
| `sessionManager` | 选择新建、恢复、内存或自定义存储 |

工具通过 `ToolDefinition` 声明 schema 和 execute，运行时提供 cwd、模型、thinkingLevel、sessionManager、取消信号等上下文。`outputSchema` 是元数据，不会自动验证结果。

恢复会话时重新提供原有扩展，工具定义和函数不能仅靠日志恢复。长期服务应在结束时 abort 并 dispose，释放连接和工具资源。

接口细节：[SDK 装配](../internals/sdk.md) · [模型运行时](../internals/providers.md)。
