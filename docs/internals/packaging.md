# 发行产物、原生模块与平台限制

操作入口：[构建安装包](../features/packaging.md)。构建脚本职责见[开发链路](development.md)。

## 产物布局

electron-builder 使用 `packages/desktop/dist/main/index.js` 为主入口，收集 desktop dist、根 package.json 和 `licenses/third-party-notices.txt`，依赖收集还包含运行时 external 包。输出 release，macOS 为 DMG，Windows 为 NSIS。

启用 asar；desktop dist/native、node-pty、Sharp 和 @img 平台包解包，因为原生加载和可执行文件不能仅作为普通 asar 内容使用。图标另作为 extraResource 复制。

主 renderer 与 quick-chat 页面、preload、history/diff workers、PDF.js 资源以及 CSS/字体/媒体都必须随构建产物存在。开发服务器提供的路径不能泄漏到发行配置中。

## Electron 与原生 ABI

使用已安装 Electron dist，npmRebuild 关闭，依赖显式 `install:terminal` 提前重建 node-pty。升级 Electron 或切换架构后重新准备，不能沿用 Node 自身 ABI 的二进制。

macOS native 构建用 xcrun clang、ARC、最低 macOS 12 和 AppKit/ApplicationServices，分别生成 copy-selection helper 与 quick-chat-focus.node。先写临时产物再 rename，清理旧命名的 helper。非 macOS 不伪造这些能力。

Sharp/@img 的二进制选择与平台/架构有关。能在开发目录 require 成功，不代表 electron-builder 收集到了正确平台版本；需要实际包内启动和媒体测试。

## 正式与 Preview

正式 appId 为 local.zpi.desktop，Preview 为 local.zpi.desktop.preview，产品名和 metadata 也分别设置。开发模式采用 Preview 身份；同名 Preview 数据和钥匙串行为需按[开发指南](../features/development.md)理解。

根应用 version 与 workspace 支持包版本是不同字段；发布补丁版通常修改应用版本及 lockfile 对应根记录，不应无理由重写所有内部包版本。

## 许可和分发

根 THIRD_PARTY_NOTICES.md 已从日常文档移除。第三方必要署名与许可原文移入 licenses/third-party-notices.txt，打包 files 指向新位置。源码中的许可指向同步更新；减少 README 内容不会取消分发时需要随包保留的文本。

## 当前限制与验收

macOS 配置 identity 为 null，构建命令不等于完成代码签名或公证。跨平台打包目标存在，也不证明每种架构的 native、焦点、权限、shell 与系统打开行为已验证。

发布前检查 package 内容并执行适用打包测试。版本号、数据 schema、transcript version 分别管理；旧程序遇到未知新 schema 应拒绝，而非自动降级覆盖数据。

源码：[打包配置](../../package.json)、[native 构建](../../scripts/build-native.mjs)、[终端准备](../../scripts/prepare-terminal.ts)、[图标](../../scripts/app-icon.mjs)、[包启动器](../../tests/helpers/electron-executable.ts)、[许可文本](../../licenses/third-party-notices.txt)。
