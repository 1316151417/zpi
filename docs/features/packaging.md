# npm 构建与发布

桌面应用、Agent SDK 和 Quick Chat 均通过 npm 分发。使用者推荐按[新手向导](getting-started.md)通过 npm 安装、npx 执行；本页面向维护者，先按[开发指南](development.md)准备依赖和原生终端模块。

## 构建 npm 包

npm 分发包使用 `npm run pack:npm` 构建，SDK 和桌面应用的 `.tgz` 输出到 `release/npm/`。桌面包包含 CLI、界面和 Worker 资源，Electron、Sharp 和终端模块作为运行依赖安装。

```sh
npm run pack:npm
```

两个包的 `prepack` 会自动构建各自的发布资源。桌面端不支持 Windows，使用 Node.js 24，通过 `npx @zpi-dev/desktop` 启动；全局命令使用 `npm install -g @zpi-dev/desktop` 安装后执行 `zpi-desktop`。SDK 保持跨平台，包含 Windows 支持，使用 `npm install @zpi-dev/agent-sdk` 安装。

## 产物检查

- 主进程、preload、renderer 及独立 Worker 都存在。
- 终端和 Sharp 原生模块与目标架构、Electron ABI 匹配。
- macOS 内容采集助手和焦点模块随桌面资源分发。
- PDF 字体、CMap、worker 和图标随本地资源分发。
- 许可证文本作为 `NOTICE` 随 npm 包分发。

使用[桌面测试](testing.md)验证历史、终端和隔离机制，再做真实系统权限、焦点、文件打开与账号验证。测试所需的目录包准备方式见测试指南。开发环境依赖存在不能证明 npm 包内资源完整；平台原生模块和运行行为需在目标平台检查。

## 发布到 npm

首次发布前创建 npm 账号、启用 2FA，并加入 `zpi-dev` 组织。日常发布先升级版本号、同步内部包依赖与锁文件，再提交并推送 Git。根项目和桌面包使用相同的应用版本，内部运行时包使用各自的 SDK 版本；npm 不允许覆盖已经发布过的包名和版本。

在 ZPI 仓库根目录执行：

```sh
npm whoami --registry=https://registry.npmjs.org/
npm run check
npm run test:unit
npm publish --workspace=@zpi-dev/agent-sdk --access=public
npm publish --workspace=@zpi-dev/desktop --access=public
```

两个包的 `prepack` 会自动构建 JS、类型声明和桌面资源。需要先检查 npm 包内容时，运行 `npm run pack:npm`，产物位于 `release/npm/`。发布按提示完成浏览器中的通行密钥认证，然后用 `npm view @zpi-dev/agent-sdk version` 和 `npm view @zpi-dev/desktop version` 确认版本已经公开；发布命令返回后，索引更新可能仍需要等待。

SDK 公开后，在独立的 `zpi-quick-chat` 仓库更新依赖并发布：

```sh
npm install @zpi-dev/agent-sdk@latest --save-exact
npm run check
npm test
npm run build
npm run test:desktop
# 提交并推送更新后的 package.json 和 package-lock.json
npm publish --access=public
```

quick-chat 必须先升级自身版本号，当前发布构建需要 Node.js 24、Apple Silicon Mac 和 Xcode Command Line Tools。网络不通时，可在配置了代理函数的终端先执行 `proxy on`。最后在源码仓库之外执行 `npx @zpi-dev/desktop --version` 和 `npx @zpi-dev/quick-chat --version` 验证 npm 入口。

## 升级

桌面端执行 `npx @zpi-dev/desktop@latest`，或通过 `npm install -g @zpi-dev/desktop@latest` 更新全局命令后执行 `zpi-desktop`。Quick Chat 对应使用 `npx @zpi-dev/quick-chat@latest`，或 `npm install -g @zpi-dev/quick-chat@latest` 后执行 `zpi-quick-chat`。SDK 在使用它的项目中通过 `npm install @zpi-dev/agent-sdk@latest` 升级。

应用数据版本与应用版本分别管理。升级前备份，未知新 schema 不会被旧程序自动降级。Preview 和正式版数据不同，开发与 Preview 默认相同。

失败时保留日志和原数据，按[备份与恢复](storage.md)处理。应用只读取当前数据格式，不自动迁移旧格式；npm 包更新不等于自动更新本地工作区文件。

原理：[构建产物与原生资源](../internals/packaging.md)。
