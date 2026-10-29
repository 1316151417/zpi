# 发送失败、超时与恢复

使用入口：[排障](../features/diagnostics.md)。连接层回退另见 [WebSocket](openai-websocket.md)。

## 先区分失败发生在哪一层

| 层 | 例子 | 处理位置 |
| --- | --- | --- |
| 凭据 | 首次请求 401、令牌到期 | 凭据解析器与一次认证恢复 |
| 传输 | 握手失败、429、503、连接断开 | 协议请求重试 / WebSocket 回退 |
| 模型流 | 首事件迟到、输出后停滞、空回答 | 流守卫与会话恢复 |
| 上下文 | 超出窗口、媒体过大 | 压缩或媒体重投影后重试 |
| 工具 | 参数不完整、执行失败、取消 | 工具结果与 journal |
| 持久化 | 写入失败、索引失败 | 阻止继续推进事实状态 |

“重试”并非把整轮副作用再做一次。已有工具调用必须先核对是否执行过、是否有完整结果；已发给用户的文本也不能在传输层悄悄重复。

## 请求级重试

适配器关闭 OpenAI SDK 的隐藏重试，显式使用 `retryProviderRequest`。辅助函数自身默认不重试，适配器可传入默认两次重试。指数延迟带抖动，通常从约 0.5 秒增长，上限 8 秒；服务端 Retry-After 优先。

默认接受的服务端等待上限是 60 秒；如果服务端要求更久，返回可解释错误，而不是擅自把它缩短到 60 秒继续冲击服务。该上限设为 0 表示不限制。等待可被 AbortSignal 取消。

分类器沿 status/code/cause 查找原因，识别临时网络错误、限流与服务端故障，也排除额度/账单、证书、用户取消等不应自动重试的情形。`x-should-retry: false` 等明确指示优先。不能只靠错误字符串里出现 “timeout” 就无限重试。

## 会话级恢复

默认开启，最多 10 次重试；本地退避起点 2 秒，上限 60 秒，总恢复时间预算 10 分钟。实际等待取本地退避与 Retry-After 的较大值，不截短服务端要求。预算从第一次失败开始，成功或手动重新尝试会重置相应状态。空回答单独限制为最多一次自动重试。

会话层把错误、下一次等待和重试控制发布给界面。停止取消当前执行和等待；立即重试针对等待控制器，不等于重新提交一条用户消息。长度结束和不可重试错误会结束当前循环。

流中断后，已完成的工具调用可以保留，尚未完成的 JSON 参数不执行。恢复逻辑将可用工具调用与已持久化结果配对，对未知或未执行调用做明确处理；journal 用来防止崩溃恢复时重复副作用。工具取消允许短暂收尾，但不能无限等待一个不遵守 signal 的扩展。

## 四种计时器

| 计时 | 默认 | 意义 |
| --- | --- | --- |
| 首模型事件 | 120 秒 | 已发请求但还没有模型响应事件 |
| 模型事件空闲 | 300 秒 | 模型流不再推进 |
| HTTP 字节空闲 | 0，关闭 | 底层响应字节停止到达 |
| UI 等待提示 | 15 秒 | 提示仍在等待，不等于超时失败 |

这些是不同层的时钟。SSE 心跳可以维持 HTTP 连接，却未必是有效生成进展；有字节不代表模型有输出。历史配置 `streamIdleTimeoutMs` 在缺少首事件配置时也参与兼容映射。超时设置的非正值按对应设置语义关闭；不要把旧文档里的统一 “5 分钟 HTTP 超时” 套到当前默认。

## 401 与上下文错误

首次错误为 401、还没有有效进展且错误没有内容时，流包装器可把被拒绝 key 交给凭据解析器。只有拿到不同 key 才重发一次；已有输出时不走这个自动恢复分支。刷新并发和轮换持久化见[授权页](openai-auth.md)。

窗口溢出交给[上下文管理](context.md)：先判断是否属于窗口错误，再压缩和重建请求；媒体过大使用专门的投影视图。不能通过删除真实历史来“修复”一次发送失败。

## 源码与回归入口

- [请求重试](../../packages/ai/src/utils/provider-retry.ts)、[错误分类](../../packages/ai/src/utils/model-retry.ts)、[会话重试策略](../../packages/ai/src/utils/retry.ts)、[流守卫](../../packages/ai/src/utils/guard-model-stream.ts)。
- [会话协调](../../packages/coding-agent/src/core/agent-session.ts)、[HTTP 字节超时](../../packages/coding-agent/src/core/http-idle-timeout.ts)、[工具 journal](../../packages/coding-agent/src/core/streaming-tool-journal.ts)。
- [恢复控制测试](../../packages/coding-agent/test/model-recovery-controls.test.ts)、[停滞恢复测试](../../packages/coding-agent/test/stream-stall-recovery.test.ts)、[工具持久化测试](../../packages/coding-agent/test/cancelled-tool-durability.test.ts)、[请求重试测试](../../packages/ai/test/provider-retry.test.ts)。
