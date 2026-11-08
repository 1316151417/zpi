# 构建与打包

构建产生可运行的桌面资源，打包进一步生成平台安装包。先按[开发指南](development.md)准备依赖和原生终端模块。

## 命令

npm 分发包使用 `npm run pack:npm` 构建，SDK 和桌面应用的 `.tgz` 输出到 `release/npm/`。桌面包包含 CLI、界面和 Worker 资源，Electron、Sharp 和终端模块作为运行依赖安装。用户使用 Node.js 24 执行 `npx @zpi-dev/desktop`，或安装后执行 `zpi-desktop`。

```sh
npm run build
npm run package:mac
npm run package:mac:preview
npm run package:win
npm run package:win:preview
```

macOS 目标为 DMG，Windows 目标为 NSIS，输出在 `release/`。Preview 使用独立产品名和 appId；开发启动采用 Preview 身份。

只需目录包时：

```sh
npm run build
npx electron-builder --mac dir
```

命令存在不代表所有目标平台已经验收。平台原生模块和发行行为需在目标平台检查，仓库当前 macOS 配置关闭了签名 identity，不能将构建成功描述成已经完成签名或公证。

## 产物检查

- 主进程、preload、renderer 及独立 Worker 都存在。
- 终端和 Sharp 原生模块与目标架构、Electron ABI 匹配。
- macOS 内容采集助手和焦点模块位于解包资源。
- PDF 字体、CMap、worker 和图标随本地资源分发。
- 许可证文本通过打包清单进入安装包。

使用[打包测试](testing.md)验证历史、终端和隔离机制，再做真实系统权限、焦点、文件打开与账号验证。开发环境依赖存在不能证明包内资源完整。

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

两个包的 `prepack` 会自动构建 JS、类型声明和桌面资源。需要先检查安装包内容时，运行 `npm run pack:npm`，产物位于 `release/npm/`。发布按提示完成浏览器中的通行密钥认证，然后用 `npm view @zpi-dev/agent-sdk version` 和 `npm view @zpi-dev/desktop version` 确认版本已经公开；发布命令返回后，索引更新可能仍需要等待。

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

应用数据版本与应用版本分别管理。升级前备份，未知新 schema 不会被旧程序自动降级。Preview 和正式版数据不同，开发与 Preview 默认相同。

失败时保留日志和原数据，按[备份与恢复](storage.md)处理。应用只读取当前数据格式，不自动迁移旧格式；安装包更新不等于自动更新本地工作区文件。

原理：[构建产物与原生资源](../internals/packaging.md)。
