# ZPI

ZPI 是一个在本机项目里工作的桌面 AI 助手。选好目录，直接说要做什么：它可以读取文件、精确编辑、写入文件和执行命令。你可以在同一个任务里看命令输出、审查文件差异，不必先切换模式。联网搜索、子智能体和记忆按需开启。

[官网](http://zjyo.cn/zpi/) · [浏览器交互演示](http://zjyo.cn/zpi/demo.html?app=zpi&autoplay=1) · [桌面使用手册](http://zjyo.cn/zpi/manuals/zpi/index.html) · [Agent SDK 手册](http://zjyo.cn/zpi/manuals/zpi-agent-sdk/index.html)

## 启动桌面版

需要 **Node.js 24.x**。桌面版主要在 Apple Silicon Mac 上验证，不支持 Windows。无需克隆仓库，在终端运行：

```sh
npx @zpi-dev/desktop
```

1. 打开 **设置 → 模型**，登录 ChatGPT，或配置自己的模型提供商（如 DeepSeek）和 API Key。
2. 点击 **添加项目**，选择一个熟悉的目录，新建任务并选好模型。
3. 发一个只读请求试试，例如：「读一下这个项目的 package.json，告诉我怎么跑测试，不要改文件。」在执行记录里可以看到它实际读了什么。

桌面工具以当前系统用户的权限运行，项目目录不是安全沙箱。初次尝试编辑或执行命令时，建议使用不含密钥的练习项目。

## 在自己的应用中使用 Agent SDK

如果只想给 Node.js 应用接入智能体，不需要安装桌面版。`@zpi-dev/agent-sdk` 提供 TypeScript 接口，可以流式读取回复和工具调用事件，也可以注册自己的业务函数。SDK 需要 Node.js 24.x，支持 Windows。

```sh
npm install @zpi-dev/agent-sdk
```

[订单查询示例](examples/agent-sdk.ts) 展示了如何用 `defineTool` 注册一个函数，让 `query` 调用它并返回结果。在本仓库安装依赖并设置 `DEEPSEEK_API_KEY` 后，可用 `npm run example:sdk` 运行；它会发起真实模型请求。

## 从源码开发

在仓库根目录安装依赖并启动桌面开发窗口：

```sh
npm ci
npm run dev
```

| 命令 | 用途 |
| --- | --- |
| `npm run check` | 运行 TypeScript 和 Biome 检查 |
| `npm run test:unit` | 运行单元测试 |
| `npm run build` | 构建桌面应用 |
| `npm run build:sdk` | 构建 Agent SDK |

桌面应用源码在 [packages/desktop](packages/desktop/)，SDK 源码在 [packages/agent-sdk](packages/agent-sdk/)。官网上的 **ZPI Quick Chat** 是用 `Option + Space` 唤起的 macOS 浮窗，在[独立仓库](https://github.com/1316151417/zpi-quick-chat)维护，不随本仓库的桌面应用启动。
