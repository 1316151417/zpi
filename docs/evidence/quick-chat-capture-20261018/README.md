# 快速对话内容带入验收

基于 main `c2895d7`（0.2.115），分支 `codex/quick-chat-capture-shortcuts`，版本 0.2.116。用户在本机通过实体键盘验证三个入口后反馈：「突然又可以了」「这三个快捷键都可以了」。

## 行为与实现

用户确认 C 指读取已经选中的文字，三种入口均带入当前对话、保留草稿、由用户确认后发送。

- Option+Shift+A：收起浮窗，调用 macOS 交互式矩形截图；成功后以图片追加草稿并唤起。Esc 取消，保留原草稿。临时输出成功、失败、取消均清理。
- Option+Shift+C：在唤起前台窗口之前，通过 AppKit / ApplicationServices 助手读取前台应用的 AXSelectedText。不模拟复制，不改写剪贴板；未授权、无选区或应用不支持时明确提示，可先复制后使用 V。
- Option+Shift+V：按键时读取剪贴板；有图片时带入图片，否则带入文字。没有后台监听剪贴板。

读取阶段连续请求合并。读取结果按原 session 校验，显式新建后的迟到采集不交给新会话。窗口的单次交付按 session / visibility epoch 领取，隐藏、重置和销毁取消待领取内容。文字追加换行，图片复用已有导入、预览、移除、失败重试、数量与内存限制。没有改变模型执行或工具 allowlist，没有自动发送。

三组命令可在快捷键设置录入、清空或禁用，旧配置仅补缺失项，冲突留空。Mac 新默认 A/C/V 不影响已保存自定义或清空值；非 macOS 默认不绑定。快速对话设置显示当前三组绑定。诊断只记录注册及 draft-offered / draft-taken 状态，不记录正文或图像。

## 已完成验证

- 完整单元测试：265 文件、3348 通过、1 跳过。之后的 Promise 预留、错误保留 cause 和展示文字调整另以对应小集复查，最终采集读取器/协调器 15 项通过；快捷键/设置等 115 项通过。
- 后台 Electron：quick-chat-capture、quick-chat、shortcuts 共 9 项通过。新增用例使用真实 main、preload、React 和图片解码，在隐藏后追加测试文字和 PNG，原草稿保留、不产生 run、session 不变；重载丢弃临时草稿。OS 采集源使用受控注入。
- 可见 Electron：quick-chat-focus / quick-chat-lifecycle，各重复三次，12 项通过；新增带入后聚焦、预览与新建清理，继续覆盖普通恢复、大窗新建后回紧凑、连续新建、运行中取消、过期及迟到结果隔离。
- `npm run check` 与构建通过，原有 4 warning / 6 info。Mac 原生助手由 clang 编译，最低部署目标 12.0。
- `electron-builder --mac --dir --publish never` 成功；检查 app.asar 中助手的 unpacked 标记，以及 app.asar.unpacked 中实际可执行文件。运行用户不需要编译器。构建产物未发布。
- 正常应用模式、隔离 HOME / ZPI_DATA_DIR 的探针已确认六组全局键均注册成功，见 [注册日志](native-registration.jsonl)。最终实体验收只绑定 A/C/V 三组，避免争用其他快捷键。探针没有模型或凭据，未发送付费请求。

## 实体键盘证据与此前失败

用户最初反馈三组按键仅输入特殊字符时，原探针进程已退出，实际运行的是主检出目录中 0.2.115 的构建；该构建不包含三组新命令。确认用户停止旧客户端后，启动加载 0.2.116 的正常模式探针（PID 16091，独立 HOME / ZPI_DATA_DIR），三个绑定均注册成功。此后实际收到回调，不能把此前问题解释成输入法拦截。

用户实体操作留下的 [原生时序](native-capture.jsonl) 只有状态、相对单调时间、session/version/epoch，没有选区、剪贴板或截图内容。以下均在同一 session `2c6f22c6-5424-4503-93b0-ca3e03522f82` 内完成，draft-taken 时原生 visible/focused 均为 true：

| 实体入口 | 回调 → 领取记录 ID | 回调至 draft-taken | 回调至 renderer-frame |
| --- | --- | --- | --- |
| A 截图 | 46 → 50 | 604.495ms | 612.902ms |
| A 截图 | 53 → 59 | 658.198ms | 661.801ms |
| C 选区 | 65 → 68 | 77.837ms | 80.417ms |
| C 选区 | 74 → 77 | 65.640ms | 70.480ms |
| C 选区 | 83 → 86 | 77.253ms | 80.307ms |
| V 剪贴板 | 92 → 95 | 27.581ms | 31.929ms |

A 的总耗时包含用户框选。draft-taken 只证明 main→preload 的一次性交付，不能单独证明 React 内容显示或图片已解码；用户最后的成功反馈与集成测试共同补充这一层证据。没有单独记录本次 V 使用文字还是图片，不将其写成两种来源均已实体验收。

C 授权过程中曾有四次错误，见 [不含内容的错误记录](native-errors.jsonl)：一次主进程未获辅助功能权限、两次 helper 无选区/不可用、一次 helper 成功退出但标准输出为空。用户报告每个应用都曾失败、文字仍高亮，随后在同一个进程、同一构建、没有修改选区逻辑的情况下连续成功。权限授予与随后成功存在先后关系，但缺少当时的 AX 错误码、焦点对象及系统授权生效时刻，无法确定后面三次失败的具体根因，不声称已修复所有应用的选区可访问性。

针对日志中真实出现的空输出，新增回归用例先在原代码得到 `Unexpected end of JSON input`，再以一条空结果检查给出可重试/手动复制提示；复测通过。该改动只改善错误信息，不声称消除了原生空结果的成因，也没有增加自动重试、延时或模拟复制。

## 仍未验证的边界

真实截图 Esc、V 的文字/图片两种来源分别验收、全屏 Space、多显示器、不同应用的选区可访问性和系统授权后的重启行为未完整验收。自动化禁止真实系统采集，不将注入来源的 Electron 用例作为 OS 读取成功的证明。

AXSelectedText 的应用支持范围由目标应用决定，不承诺读取所有应用的选区。实现依据：[Apple 选区属性](https://developer.apple.com/documentation/applicationservices/kaxselectedtextattribute)、[Electron 系统权限接口](https://www.electronjs.org/docs/latest/api/system-preferences)。
