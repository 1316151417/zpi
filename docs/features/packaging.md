# 构建与打包

构建产生可运行的桌面资源，打包进一步生成平台安装包。先按[开发指南](development.md)准备依赖和原生终端模块。

## 命令

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

## 升级

应用数据版本与应用版本分别管理。升级前备份，未知新 schema 不会被旧程序自动降级。Preview 和正式版数据不同，开发与 Preview 默认相同。

失败时保留日志和原数据，按[迁移与回滚](storage.md)处理。安装包更新不等于自动更新本地工作区文件。

原理：[构建产物与原生资源](../internals/packaging.md)。
