# 测试隔离、真实边界与清理

命令入口：[运行测试](../features/testing.md)。测试文件数量会变化，文档不固定成功数量。

## 分层

Vitest 覆盖核心、服务和指定 DOM 测试。Node 项目与 Happy DOM 项目分别配置，文件隔离、环境恢复，默认 worker 为可用资源的 50%，默认超时 15 秒。假模型服务器控制 SSE、工具调用、错误和等待，不使用真实账号。

Playwright 默认运行真实 Electron，覆盖 renderer/preload/main、原生视图、PTY 和打包读取。默认隐藏且不可聚焦，单 worker 避免共享 dist 构建竞争。显式 interactive 配置另测真正焦点与显示行为，不混进常规回归。

## 临时环境

统一 unit environment 在导入业务代码前隔离 HOME、缓存、临时目录和可能影响 shell 的变量，防止读取个人凭据或配置。每个测试自己建立所需目录、Git 仓库、文件和假服务，不能依赖开发者机器已有工具配置。

桌面必须使用统一 fixture/launchDesktop，指定独立 userData 和测试 scope，清除不应继承的系统变量。测试身份与普通 Preview 区分，不能只换一个窗口标题就认为隔离完成。

## 系统副作用

测试桥接封装 clipboard、外部应用打开、通知、全局快捷键与原生对话框。默认测试验证调用意图及边界，不真的把内容复制到用户剪贴板或打开其应用。输入粘贴用构造事件；真实跨应用 capture 属于显式交互测试。

脚本 `test-desktop.ts` 验证命令参数并禁止默认入口使用 debug/UI/headed 等逃出隐藏模式的选项，HTML reporter 不自动打开浏览器。开发启动器也主动拒绝 test scope。

## 进程收尾

launcher 记录本次 scope 的进程及临时目录，正常关闭和异常退出都回收。guardian 与进程快照辅助处理测试 runner 提前退出，清理只针对本次拥有的进程，不能全局 pkill Electron 或 shell。

`test:cleanup` 用故障场景验证退出后的残留；`test:safety` 静态检查危险用法和隔离约定。它们不替代功能测试，但防止测试本身破坏正在使用的桌面。

## 包与平台验证

打包用例要求真实 `.app`，launcher 复制到临时目录，拒绝缺少当前测试隔离能力的旧包。源构建通过、Node SQLite 测试通过、macOS 包通过、Windows 运行通过是不同证据，应分别报告。

基准脚本使用合成数据，记录样本、冷/热缓存、机器和指标。一次历史 benchmark 不是长期门槛；新增性能优化需要相同条件下前后比较。

源码：[Vitest](../../vitest.config.ts)、[Playwright](../../playwright.config.ts)、[unit 环境](../../tests/unit-environment.ts)、[桌面 launcher](../../tests/helpers/desktop.ts)、[隔离](../../tests/helpers/desktop-isolation.ts)、[scope](../../tests/helpers/desktop-scope.ts)、[安全检查](../../tests/safety-check.ts)、[清理验证](../../scripts/verify-test-cleanup.mjs)。
