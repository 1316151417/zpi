# 输入、附件、引用与发送队列

使用入口：[对话](../features/conversations.md)、[文件引用](../features/files.md)。

## 从草稿到已接受输入

renderer 保存编辑状态和附件引用，通过 preload 提交 RunInput。主进程负责确认 session、校验文本/文件/附件、展开引用、保存用户输入事实，再启动模型。UI 点击发送与主进程成功接受是不同时间点；失败不能提前清掉不可恢复的草稿。

图片由主进程管理导入、所有权和持久化路径，IPC 传递受控 ID。文件引用可携带行号或评论；会话引用由宿主读取目标会话可用内容，不让 renderer 自己拼绝对数据路径。命令 shell 展开在实际执行阶段发生，入队校验不会执行 shell。

## 每个会话独立串行

`SessionInputQueue` 为每个 session 建立 Promise 链，防止发送、删除、排序、立即发送同时修改队列。commit 顺序为 save → 内存状态 → publish；保存失败时不能先显示已成功。

排队项状态为 queued 或 dispatching，含文本、引用和已保留附件。附件不能同时属于两个队列项；retain 成功后才保存队列，保存失败就解除保留。移除项释放资源，取回编辑则把资源交回草稿。

## 派发与去重

派发前先把项改为 dispatching，再调用宿主 start。宿主接受后移出队列；若接受之后队列保存失败，内存中仍移除该项并暂停，避免同一输入再次执行。历史记录中的 accepted input IDs 在重启恢复时再次去重。

恢复的残余项统一回 queued，有剩余项就暂停自动发送并显示 restart 原因。正常完成可继续排队；错误或停止会暂停，等待用户决定。重启不是重新授权执行全部积压命令。

## 立即发送与归档

立即发送先校验新输入，再停止当前 run。preempting 标记防止被中断 run 的 settled 回调误停后续队列。用户选择清空旧队列时也先确保新输入有效，防止一次无效发送删掉已接受消息。

归档在同一串行链中检查已停止，持久化归档后清空队列并回收附件。关闭应用时停止接收新操作，等已排队操作收尾，将剩余输入保存为暂停状态。

## 源码与回归入口

- [队列](../../packages/desktop/src/main/input-queue.ts)、[附件](../../packages/desktop/src/main/attachments.ts)、[会话引用](../../packages/desktop/src/main/session-references.ts)、[草稿](../../packages/desktop/src/main/draft-store.ts)、[引用解析](../../packages/coding-agent/src/core/mentions.ts)。
- [队列测试](../../packages/desktop/test/input-queue.test.ts)、[归档测试](../../packages/desktop/test/input-queue-archive.test.ts)、[引用测试](../../packages/desktop/test/input-references.test.ts)、[附件测试](../../packages/desktop/test/attachments.test.ts)。
