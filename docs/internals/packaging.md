# npm 发行产物、原生模块与平台限制

操作入口：[npm 构建与发布](../features/packaging.md)。构建脚本职责见[开发链路](development.md)。

## 产物布局

`npm run pack:npm` 构建 Agent SDK 和桌面应用，输出 `.tgz` 到 `release/npm/`。SDK 将内部运行时打包并生成独立类型声明；桌面包收集 `bin`、`dist`、`scripts`、README 和 `NOTICE`。Quick Chat 在独立仓库构建并发布 npm 包。

桌面 CLI 设置 `ZPI_NPM_LAUNCH=1`，通过 Electron 运行包内的 `dist/main/index.js`。Electron、node-pty 和 Sharp 是 npm 运行依赖，内部 workspace 模块已包含在构建中。用户不需要源码仓库或本地构建。

主 renderer、preload、history/diff workers、PDF.js 资源以及 CSS、字体和媒体都必须随构建产物存在。开发服务器路径不能泄漏到发行配置中。

## Electron 与原生 ABI

npm 安装需允许依赖安装脚本下载 Electron 运行环境；桌面包的 `postinstall` 为 macOS 的 node-pty spawn helper 补齐执行权限。源码开发依赖显式 `install:terminal` 提前重建 node-pty。升级 Electron 或切换架构后重新准备，不能沿用 Node 自身 ABI 的二进制。

Sharp/@img 的二进制选择与平台/架构有关。能在开发目录 require 成功，不代表 npm 安装后的依赖满足目标平台；需要在安装后的 npm 包中验证启动、媒体和终端。

## 正式与 Preview

npm 启动使用正式版 `ZPI` 数据目录，正式 appId 为 local.zpi.desktop。开发模式采用 Preview 身份 local.zpi.desktop.preview；Preview 数据和钥匙串行为需按[开发指南](../features/development.md)理解。

根应用 version 与 workspace 支持包版本是不同字段；发布补丁版通常修改应用版本及 lockfile 对应根记录，不应无理由重写所有内部包版本。

## 许可和分发

第三方必要署名与许可原文保存在 `licenses/third-party-notices.txt`，SDK 和桌面构建脚本将其复制为各自包内的 `NOTICE`，随 npm 包分发。减少 README 内容不会取消分发时需要随包保留的文本。

## 当前限制与验收

npm 包能安装不代表每种架构的 native、焦点、权限、shell 与系统打开行为已验证。Quick Chat 当前仅支持 macOS arm64；桌面端的原生依赖和运行行为需在目标平台验收。

发布前检查 npm 包内容并执行适用桌面测试。版本号、数据 schema、transcript version 分别管理；旧程序遇到未知新 schema 应拒绝，而非自动降级覆盖数据。

源码：[npm 打包入口](../../scripts/pack-npm.mjs)、[桌面包配置](../../packages/desktop/package.json)、[CLI 启动器](../../packages/desktop/bin/cli.mjs)、[终端安装准备](../../packages/desktop/scripts/prepare-terminal.mjs)、[许可文本](../../licenses/third-party-notices.txt)。
