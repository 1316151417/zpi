# 运行与选择测试

测试分为 Node 单元/服务测试、默认隐藏 Electron 集成测试、显式交互测试和打包测试。它们验证不同边界。

## 单元和服务测试

```sh
npm run test:unit -- packages/desktop/test/side-chat.test.ts
npm run test:unit
```

Vitest 运行 `packages/*/test/**/*.test.ts`，不启动桌面窗口。部分测试使用假 HTTP 模型、Git、Shell、临时文件和 Happy DOM，不能把它们全部称为纯函数测试。

每个文件有隔离 HOME、缓存和临时目录，清除可能影响 Shell 的继承变量。默认 worker 占可用资源的一部分，完整并发仅在专用环境按需要调整。

## 默认 Electron 集成

```sh
npm run test:desktop -- tests/desktop/side-chat.spec.ts
npm run test:desktop -- tests/desktop/hidden-window.spec.ts --repeat-each=2
npm run test:safety
npm run test:cleanup
```

默认先检查、构建，再单 worker 执行真实 Electron。窗口隐藏且不可聚焦，但 renderer、preload、IPC、浏览器视图和 PTY 都是真实路径。Linux 仍需要图形环境或虚拟显示。

测试从 `tests/helpers/test.ts` 导入统一 fixture，使用 `launchDesktop`。系统剪贴板、通知、外部应用、真实全局快捷键和原生对话框有隔离边界。粘贴用构造的事件，不能对用户桌面发系统粘贴键。

多个桌面套件应串行，避免同时重建共享 dist。默认入口不允许 debug/UI/headed 或替换配置来显示窗口。

## 显式交互验证

```sh
npx playwright test --config=playwright.interactive.config.ts --list
npm run test:interactive
```

第一条仅列出，第二条会显示窗口并改变焦点，运行前需取得正在使用该桌面的人的同意。仍隔离数据和系统副作用。

真实全局键、Space、系统权限、跨应用复制和物理键盘属于目标平台验证。默认套件中的模拟注册不能证明系统实际注册成功。

## 快速对话的人工系统验收

在独立试用数据和专门桌面环境中，依次检查以下场景并记录系统、版本与结果：

1. 从另一个应用按真实全局键唤起，确认输入焦点到浮窗、主窗口不被带到前面。
2. 输入草稿后隐藏和恢复，确认文字/附件保留，Esc 后焦点回到来源应用。
3. 分别在隐藏、有内容、空白、运行中使用新建键，确认重置、停止和再次收起语义；快速重复按键不出现两个新会话。
4. 跨 macOS Space 和全屏应用切换，确认浮窗隐藏与再次唤起；检查迟到 blur 不会立即关闭新窗口。
5. 使用真实选区和截图带入，分别验证首次权限、拒绝权限、剪贴板未变化、取消和临时资源清理。
6. 区分冷启动、热唤起和超过 15 分钟后恢复，核对实际可见性和可输入时间。帧回调或模拟 API 时间不等于屏幕像素延迟。

这些是人工步骤，列出它们不代表已经执行。默认隐藏测试和显式交互套件仍不覆盖所有真实全局热键、系统剪贴板及 Space 行为。

## 打包测试

完整桌面套件中的打包用例需要现成 macOS `.app`，`build` 本身不生成安装包：

```sh
npm run build
npx electron-builder --mac dir
ZPI_TEST_PACKAGED_APP="$PWD/release/mac-arm64/ZPI.app" npm run test:desktop -- tests/desktop/history.spec.ts tests/desktop/terminal.spec.ts
```

路径按实际架构调整。启动器复制应用到临时目录，拒绝缺少当前隔离机制的旧包。

## 如何报告结果

列出实际运行的命令、通过/失败/未运行及原因。收集到测试不代表运行通过；DOM 和截图分别验证行为与外观；Node SQLite 烟测不代表发行包恢复验证。

性能脚本生成临时合成数据，按需运行 `scripts/benchmark-lazy-restore.ts`、`benchmark-history-worker.ts` 和 `benchmark-storage-migration.ts`。环境、样本、缓存状态和指标定义应随结果保存，不引用旧报告当当前性能承诺。

原理：[隔离、进程清理和覆盖层次](../internals/testing.md)。
