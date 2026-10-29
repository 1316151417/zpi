# 本地开发和调试

开发使用 Node.js 24、npm 和 Electron。macOS 原生模块需要 Xcode Command Line Tools。

## 首次安装

```sh
npm install --ignore-scripts
npm run install:electron
npm run install:terminal
npm run dev
```

依次安装依赖、Electron 二进制、与 Electron ABI 匹配的终端模块。升级 Electron 后重新运行 `install:terminal`。

`dev` 以 ZPI Preview 身份启动。renderer 使用 Vite HMR，主进程、核心和 preload 改动触发相应重建与重启。Ctrl+C 结束开发进程。

## 隔离试用数据

开发版默认与安装的 Preview 共用数据和钥匙串身份。需要独立数据时指定绝对路径：

```sh
ZPI_DATA_DIR=/absolute/path/zpi-trial npm run dev
```

这不隔离项目权限或网络，也不会自动清除环境 API Key。已有正式数据先按[存储指南](storage.md)备份。测试模式有自己的临时目录和系统边界，不能把测试模式通过当成真实账号、权限和全局热键验证。

## 常用检查

```sh
npm run check
npm run test:unit -- packages/desktop/test/side-chat.test.ts
npm run build
```

`check` 执行 TypeScript 和 Biome；`format` 会写格式修复。先运行受影响的测试，再扩大到相关套件。完整命令与 GUI 边界见[测试](testing.md)。

## 调试

开发窗口的 View 菜单可打开 DevTools。`ZPI_DEV_DEBUG=1 npm run dev` 给 Electron 添加随机端口的 Chromium 远程调试入口；它不是 Node 主进程 inspector。renderer、主进程和 Worker 的错误归属不同，应结合[日志](diagnostics.md)定位。

修改文件/进程/凭据操作时，从主进程服务、shared IPC 类型和 preload 入口追踪，避免在 renderer 引入特权实现。查看[进程与状态边界](../internals/runtime.md)。

## 修改文档

README 只维护链接。功能操作放 `docs/features`，算法、协议、状态和失败机制放 `docs/internals`，整体边界放[总览](../design.md)。新增模块进入[源码地图](../internals/module-map.md)。

验证链接和示例是否仍与源码匹配，不把历史测试计数、临时工作树状态或一次性任务限制写成长期规则。

实现：[开发启动和构建](../internals/development.md)。
