# 快速对话原生时序排查（0.2.113）

基线：拉取后 `origin/main = 2a1727f`（0.2.112），当前工作树和 main 工作树均无未提交修改。Node 24.12.0、macOS、Electron 41.10.7。先加诊断、不改行为，再复现；下面的“修复前”均为 0.2.112 行为加诊断。原生窗口及切桌面验证已获用户同意。

## 两个独立问题

### 迟到的 hide/blur 取消隐藏中的新唤起

真实 Electron 面板用例修复前连续失败两次。不是 FakeWindow：使用实际 QuickChatHost、QuickChatWindow、preload、React、IPC 和原生窗口，仅模型服务为本地 fake HTTP。直接调用与快捷键相同的 `toggle(true)`，不注入 ACK 或窗口状态。

[before-native.jsonl](before-native.jsonl) 的关键顺序（`at` 是本进程单调毫秒）：

| 时间 | 事件 | 状态 |
| --- | --- | --- |
| 443.195 | program-hide | 旧窗口可见、聚焦，epoch 1 |
| 448.919 | 新建 | 窗口已隐藏，epoch 2；随后进入 opening epoch 4 |
| 449.349 | 迟到 native-blur | 窗口仍隐藏，intent=true，resetting=true，opening=4 |
| 449.387 | blur-unfocused | 错把旧 blur 作为新展示的失焦，执行 hide，把 epoch 推到 5 |
| 454.041 | 新 session snapshot | intent 已变为 false |
| 454.107 | 新建结束 | outcome=cancelled，没有调用 show |

原实现只处理了“旧事件抵达时新窗口已经聚焦”的情况。隐藏准备中的窗口还没有焦点，原生 hide/blur 却按新 visibility epoch 处理。普通恢复空白大窗也会经历 composer probe 和折叠帧等待，同样存在这个窗口期。

修复将现有 opening 操作分为 `preparing` / `presenting`：原生隐藏时开始的操作先准备，调用 native show 前转入呈现；若原生窗口原本可见，准备新内容期间仍属于呈现。只有隐藏准备中的旧 hide/blur 被忽略。显式 hide、Esc、Space 变化仍取消 opening；已呈现窗口真正失焦仍隐藏。[after-native.jsonl](after-native.jsonl) 保留了忽略旧事件后正常显示的同一 epoch 记录。

### 空闲 reset 在实际全局快捷键回调中空等

实体键盘复测使用正常应用模式，独立临时 HOME、数据目录及空 Shell 配置，开启 `ZPI_QUICK_CHAT_TIMING=1`；没有配置模型或发送请求。只读核对用户 Preview 的实际配置为启用的 `Alt+N` / `Alt+Shift+N`，没有假定默认值。启动日志三项全局注册分别成功一次，用户按键确实进入相应回调；本轮没有观察到重复注册或系统抢占。

用户指出最后一次新建慢。分段日志把延迟定位到 `QuickChatHost.clearSession()` 无条件 `await this.stop()` 的续执行；此时 `active` 为空，`stop()` 没有取消工作。不是 host 的计算、IPC、React 或帧确认耗时。保存的[实体键盘计时投影](manual-timings.jsonl)保留原始记录 ID、进程单调时间、session/version/epoch 和各阶段；省略重复状态字段。

| 最慢新建的阶段 | 修复前相对毫秒 |
| --- | ---: |
| reset-dispatched | 0.145 |
| host-stop-ready | 573.976 |
| host-dispose-ready | 574.006 |
| host-selection-ready | 574.162 |
| host-published | 574.537 |
| session-frame-ready | 578.151 |
| show / focus | 581.753 / 581.767 |
| renderer-frame | 604.772 |

同轮其他空闲 stop 续执行耗时约 17、76、106ms；较早一轮也捕获到 146、336ms 的 reset。延迟变化发生在已经返回的空闲 Promise 续执行处，解释了为什么 Node/Happy DOM 和通过 Playwright 的主进程调用很快，而实体全局快捷键时快时慢。这是本机调度证据，不据此断言 Electron 内部某个未验证的缺陷。

修复在没有 active run 时同步清理并发布新 session，避免在首个 snapshot 前等待空闲 stop；有 active run 时仍等待真正取消完成。先预留 reset promise，再发布 snapshot，保留并发合并、重入保护和 send 的 busy 边界。没有新增定时等待、删除超时或提前展示旧内容。

同机实体键盘修复后保存的三次新建：host-stop-ready 为 0.119–0.148ms，发布 snapshot 为 0.402–0.515ms，show 为 8.770–12.053ms，renderer-frame 为 36.139–37.624ms。`show` 状态确认原生 visible/focused；renderer-frame 是渲染机会报告，不是合成器像素证明。用户复测反馈：“这次快多了，没有卡顿”。

250ms probe、5 秒 ACK 失败、1.5 秒预热均保留；上述慢样本没有命中它们。

## 与主窗口及 .108–.112 的关系

主窗口按钮走 renderer `newSession()`，优先复用已有 draft；需要创建时通过 `createSession` IPC 建立任务。它没有快速对话的隐藏窗口准备、全局原生回调里的空闲 stop、probe 或 native show 之前的 session frame 等待。主窗口实测的[点击至输入就绪样本](main-input-latency.json)包括 Playwright 等待和首屏启动，不能与主进程 show 耗时直接相减。

- .108 已有无条件空闲 stop 与只考虑已聚焦窗口的旧 blur 防护，两个缺口不始于 .112。
- .109 优化的是 snapshot 后的 React/帧调度。实测最长等待在 snapshot 发布之前，所以缩短一帧无法解决它。
- .110 把 pending 当可关闭状态的回归，.111 已用 opening 合并修正，本轮保留此语义。
- .112 增加有内容新建和空白 probe 分支；普通空白大窗恢复已有 probe/折叠帧等待。这些异步准备阶段都必须区分隐藏准备与已呈现，不能仅凭 intent=true 推断旧原生事件属于新显示。
- 没有在本轮观察到 ACK 被错误接收、旧 finally 清理新 opening、同一新建重复 reset，或已完成 reset promise 导致长期等待；未为这些猜测加行为分支。

## 回归与范围

最终验证（原生时序与样本用 JSONL 每行保留一个记录）：

- `npm run check`：通过；保留原有 4 条 warning、6 条 info，无 error。
- `npm run build`：通过。
- `npm run test:unit`：263 文件、3327 通过、1 跳过。新增真实缺口对应的延迟 native blur/hide、普通折叠恢复、空闲同步发布及重入保护用例。
- 后台 Electron：`tests/desktop/quick-chat.spec.ts`、`tests/desktop/shortcuts.spec.ts`，8 通过。
- 可见 Electron：`tests/interactive/quick-chat-focus.spec.ts`、`tests/interactive/quick-chat-lifecycle.spec.ts`，每项重复三次，12 通过；收尾调整后再对生命周期与主窗口对比用例重复三次，6 通过。
- 原生生命周期：30 轮隐藏空白新建、可见草稿新建、空白再次收起、普通恢复；另覆盖已完成历史、可见历史新建、大窗草稿恢复、左上＋连续无条件新建、空白大窗折叠、8 连按合并、fake HTTP 运行中取消及迟到旧结果隔离、过期、真实 blur 后重新唤起。

[after-latency.jsonl](after-latency.jsonl) 保存三轮样本：隐藏空白新建主进程调用约 1.9–13.8ms；从测试发起到真正填入并读回文本约 33–68ms，包含跨进程测试开销。有历史空闲恢复约 1.1–2.8ms。它们是本机实际 Electron 测量，不是受控 rAF 预算，也不代表所有机器的保证。

复跑可见用例前仍需使用者同意：

```sh
npm run test:interactive -- tests/interactive/quick-chat-focus.spec.ts tests/interactive/quick-chat-lifecycle.spec.ts --repeat-each=3
```

实体键盘两组回调、普通显示/隐藏及新建前后速度已核验，也观测到实际 Space 变更通知；没有将这些少量试用等同完整 Spaces 验收。全屏 Space、多显示器、Dock 排列、不同键盘布局/输入法、长期睡眠唤醒、系统热键抢占及真实模型/工具取消仍未完整验收。过期的原生集成用例推进了 host 单调时钟，没有真的等待 15 分钟；旧 ACK、重载和取消的并发边界另有单元/renderer 回归。没有发送付费模型请求或修改实际会话数据。正常应用模式的临时实例已退出并释放快捷键。
