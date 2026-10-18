# 空白大窗隐藏后恢复慢：0.2.114 本机验收

基线是 main `4d83b6761b438e1bbce96ac9557d3f6342933c67`（0.2.113）。本轮开始时工作树干净，已 fetch，远端无更新；在 `codex/fix-quick-chat-compact-resume` 修复。测试使用临时 HOME / ZPI_DATA_DIR、独立标识的 Electron 41.10.7 应用和本地假 SSE 服务。没有加载用户凭据、发送付费请求或修改真实会话。用户已授权随时进行弹窗验收，并关闭了自己的客户端；通过设置保存并从注册日志确认 `Alt+N` / `Alt+Shift+N`。

## 真实复现与根因

实体键盘顺序：带已完成历史的快速对话大窗 → Option+Shift+N 新建并保持大窗 → Option+N 隐藏 → Option+N 恢复为空白紧凑窗。用户反馈基线“复现了，大概一秒多”。

[修复前关联记录](before-physical.jsonl) 中，快捷键记录 57 已收到 `Alt+N`，当时 native visible/focused 均 false，presentationVersion/rendererVersion 均为 2，没有 reset、opening、waiter 或 probe。紧随其后的 open 58（epoch 9→10）记录：

| 阶段（相对 open 起点） | 毫秒 |
| --- | ---: |
| expiry-ready | 0.034 |
| window-ready | 1042.441 |
| composer-probe（按单调时钟关联） | 1042.906 |
| composer-reply | 1044.241 |
| session-frame-wait | 1048.501 |
| session-frame-ready | 1058.786 |
| show，native visible/focused=true | 1064.516 |
| renderer-frame | 1073.282 |

慢段发生在首个 IPC 之前。该分支的窗口已加载且常驻，但 `show()` 仍无条件进入 `Promise.all([ready(), undefined]).then(...)`，之后才询问 renderer 是否存在草稿。在真实全局快捷键回调中，后续 Promise 回调过了约一秒才执行。普通有历史恢复和紧凑恢复直接同步 show，不经过这个分支，因而出现特定顺序必慢的差异。0.2.113 修复的是空闲 reset 发布前的 await，未覆盖这条不 reset 的恢复路径。

日志证实的是主进程准备链的延迟，不足以断言 Electron/Cocoa 内部的具体调度缺陷。没有重载 JS、等待模型或命中 250ms probe / 5 秒帧失败 / 1.5 秒预热超时；本次 probe 实际回包只花约 1.3ms。

## 最小修复与同机对比

抽出原有准备函数：窗口已就绪且无需 reset 时同步进入，在全局快捷键调用栈发出首个 composer IPC；需要加载或 reset 时保留原有等待。没有添加布尔状态或延时。仍等待真实草稿判断、匹配 session/version 的折叠帧 ACK，并保留超时、epoch 取消及 pending 合并。

[修复后关联记录](after-physical.jsonl) 保存两次同序列的实体键盘恢复，open 34 / 65：

| 阶段 | 第一次 ms | 第二次 ms |
| --- | ---: | ---: |
| window-ready | 0.029 | 0.015 |
| composer-probe | 0.246 | 0.052 |
| composer-reply | 0.686 | 0.483 |
| session-frame-ready | 15.919 | 9.694 |
| show，native visible/focused=true | 17.786 | 11.819 |
| renderer-frame | 41.015 | 37.311 |

用户同机复测反馈“现在快了”。show 是原生调用返回并检查状态，renderer-frame 是渲染机会报告；二者都不等同合成器像素时间。本轮也要求显示后输入，未单独测量实体按键到屏幕字符的延迟。

## 回归与限制

- 新增单测在未修改的 0.2.113 上先失败：`warm blank-expanded resume sends its composer request in the invocation stack`，toggle 返回前 send 次数为 0；修复后通过。它只锁定首个请求的调度契约，真实慢表现由上述实体键盘证明。
- 可见 Electron `quick-chat-focus.spec.ts` 与 `quick-chat-lifecycle.spec.ts` 各重复三次，12 项通过。补入完成历史新建→立即普通隐藏→普通恢复的完整路径，并验证可见聚焦、44 DIP 和可输入。继续覆盖大窗草稿保留、左上＋无条件新建、连续新建合并、运行中取消及迟到旧结果隔离、过期恢复、真实 blur 后恢复。
- 后台 Electron `quick-chat.spec.ts` 与 `shortcuts.spec.ts`，8 项通过，使用 0.2.114 构建。
- `npm run test:unit`：263 文件、3328 通过、1 跳过。`npm run check` 通过，原有 4 warning / 6 info；构建通过。

自动化 Electron 通过 app API 调用，不能代替全局快捷键原生回调；这正是此前自动化未暴露本次慢段的原因。本轮没有重新完成全屏 Space、多显示器、不同输入法、睡眠唤醒及长期运行验收，不能将本次结果推广为这些边界已通过。假服务取消覆盖结果隔离，不代表真实模型/工具取消均已验证。隔离手动实例已退出并释放全局快捷键。
