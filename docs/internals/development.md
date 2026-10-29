# 开发启动与构建链路

操作入口：[本地开发](../features/development.md)。发行产物见[打包原理](packaging.md)。

## 环境与依赖

仓库是 npm workspace，五个包以内部包名互相引用。Node 24 提供当前运行时所需能力，尤其 `node:sqlite`。根安装先禁用 lifecycle scripts，再显式安装 Electron 和重建 node-pty，避免原生 ABI 准备被隐含步骤掩盖。

TypeScript 负责类型检查；Biome 负责格式与静态规则。源码采用 ESM，main 构建目标 Node 24，preload 因 Electron 加载方式输出 CJS。代码中的 `.ts` 引用由构建链解析，不要求把整个仓库预先编译成一个公共 dist。

## dev 顺序

开发脚本拒绝测试作用域，防止测试误启动交互式窗口。启动时准备终端、macOS capture/focus 和图标，再开启 Vite。默认 loopback 5173 strictPort，可用 ZPI_DEV_PORT 改端口。

macOS 在 node_modules 缓存目录复制 Electron bundle 并改显示名为 ZPI Preview，不修改原始 Electron 安装。主进程 watch 覆盖 main/shared/preload 及 ai/agent/coding-agent。每次 main 构建成功，先构建 preload、停止旧 Electron，再用新入口启动；renderer 由 Vite HMR 更新。

子进程清除 ELECTRON_RUN_AS_NODE，传入 ZPI_DEV_URL。SIGINT/SIGTERM 进入幂等关闭路径，收尾 Electron 并关闭 Vite。不能在旧进程未结束前不断叠加新的桌面实例。

## build 分工

先准备终端和图标，随后可并行构建 macOS native、main、preload、renderer。main 入口包含 index、diff-worker 和 history-worker；preload 有主窗口和 quick-chat 两份。

Vite base 为相对路径，生产资源可在文件 URL 下加载。PDF assets 插件复制本地依赖，worker 输出保留必要入口副作用，不能被 tree shaking 删除。源码映射用于本地诊断和包内错误定位。

main bundle 包含 workspace 核心及常用 JS 依赖，Electron、node-pty、Sharp 保持 external；原生依赖由发行包收集。createRequire banner 处理 ESM 与相关 CommonJS 依赖边界。

## 修改原则

新增主进程能力同时检查 shared 类型、preload 暴露和 renderer 调用；业务逻辑尽量放可单测服务。新增 worker 或本地资源必须加入构建入口，开发模式能打开不等于发行包已经包含。

源码：[dev](../../scripts/dev.mjs)、[进程收尾](../../scripts/dev-process.ts)、[build](../../scripts/build.mjs)、[main/preload 配置](../../scripts/desktop-build.mjs)、[Vite](../../packages/desktop/vite.config.ts)、[PDF assets](../../packages/desktop/pdf-assets-plugin.ts)、[根配置](../../package.json)。
