# OpenAI Responses WebSocket 与增量续接

对应功能：[模型接入](../features/models.md)。连接由每个 `AgentSession` 的 `ResponsesSession` 管理；连接和 response ID 只在内存中，历史仍保存在本地。

## 准入与预热

只有 `openai-responses` 且地址精确匹配 `https://api.openai.com/v1`（允许末尾斜杠）才允许自动 WebSocket。兼容网关沿用 HTTP。自定义 fetch 默认选择 HTTP，宿主需显式启用 auto；注册自定义 stream 的提供商不进入内置连接管理器。

`prepareResponsesSession` 先销毁旧管理器，再用零延时任务准备预热，让模型和思考设置稳定。预热发送 `response.create` 加 `generate:false`，不写会话日志、不计正式模型性能。若用户输入已经就绪，清除还没开始的预热定时器，直接生成。

| 边界 | 值 |
| --- | --- |
| 代理解析期限 | 10 秒 |
| WebSocket 握手期限 | 10 秒 |
| 预热总期限 | 15 秒 |
| 空闲释放 | 请求结束后 5 分钟 |
| 连接年龄检查 | 下一请求时超过 55 分钟则重建 |
| HTTP 降级冷却 | 60 秒 |
| SDK 流事件缓冲 | 4096 条 |

## 代理与连接身份

桌面通过 Electron 解析系统/PAC 代理，`responsesProxyUrl` 取解析结果第一条规则，将 PROXY/HTTPS 或 SOCKS 规则转成 Node agent。DIRECT 不加代理。不支持的规则报错进入传输处理。

身份哈希包含 provider、model ID、auth、baseURL、当前 API Key、模型及请求 headers。身份改变会关闭连接、清空续接状态并取消旧 HTTP 冷却。哈希和令牌都不进入普通传输诊断。

WebSocket 使用 OpenAI `ResponsesWS` 与 `ws`，开启 `perMessageDeflate`。这是可协商的帧压缩，是否实际压缩取决于握手协商；它不摘要对话、不降低模型 token 数。

## 串行所有权

每个请求先接到 Promise tail，等待上一个拥有者释放。预热和生成使用同一队列，意外共享管理器的并发调用也不会同时写 socket。

等待者取消时，其 release 仍等前一个拥有者结束才执行，防止后续请求越过正在工作的请求。dispose 取消生命周期信号并断开连接；排队者不会在销毁后重新建连。

## 连接复用和 response 续接是两层判断

连接仍打开且身份一致时可以复用 socket。是否发送增量还要求：

1. 存在上次成功完成的 response ID。
2. 除 input、stream、background、previous_response_id 之外的请求设置深度相同。
3. 上次记录的输入是当前完整输入的精确前缀。

满足时发送新增 input 后缀和 `previous_response_id`，否则在可用连接上发送全量输入。全量指当前有效模型上下文，不是所有被压缩的原始历史。

```json
{
  "type": "response.create",
  "model": "<model-id>",
  "input": [{ "type": "function_call_output", "call_id": "<call-id>", "output": "<result>" }],
  "previous_response_id": "<previous-id>"
}
```

这是脱敏形状示例。实际请求还包含当前系统指令、工具和模型参数等设置。

## 完成后如何建立下一个前缀

收到 `response.completed` 后，保存本次 input 加规范化输出。输出转换与下一次便携历史请求保持一致：保留 reasoning 项、有效文本和 phase，工具调用参数转为稳定 JSON，ChatGPT 工具使用 `ZPI` namespace。

响应必须是预热，或有 output，或有 token usage，才接受为续接锚点。参数解析异常、incomplete 和连接关闭会清空 previous，避免在错误形状上继续。

模型切换会重建会话管理器；令牌变化会改变连接身份。编辑历史、压缩、系统参数改变或媒体预算投影改变前缀时不能沿用旧 response ID。进程重启后必须从本地上下文重新开始。

## 错误、全量重连和 HTTP 降级

| 情况 | 行为 |
| --- | --- |
| socket 已在 CLOSING/CLOSED | 断开并新建，全量输入 |
| 无输出时连接寿命限制 | 新 WebSocket 全量重试一次 |
| 无输出时 previous_response_not_found | 新 WebSocket 全量重试一次 |
| 有 parent 的 400，正文明确无效 previous_response_id | 同上 |
| 连接/代理/升级失败，尚无模型输出 | HTTP 回退并进入冷却 |
| 预热失败 | 最佳努力结束，可进入冷却，不额外生成 HTTP 回答 |
| 鉴权、额度或请求错误 | 交调用者，不伪装成普通传输重试 |
| 已有模型输出后断线 | 交会话恢复层，传输层不静默重放 |
| 用户取消或 dispose | 关闭并抛出，不回退 |

模型输出判定关注 output、reasoning、工具参数、refusal 类事件，纯传输元信息和心跳不算已经输出。完成后也不会因为后处理异常重放已完成生成。上层逻辑见[失败恢复](recovery.md)。

## 诊断与回归

事件记录 request/reconnect/fallback/complete/error、transport、warmup、固定原因和累计计数，包括建连/复用、全量/增量、失败和 HTTP 次数。最近实际输入项数可与完整上下文项数比较。没有正文、令牌、响应 ID 或服务器错误正文；观察回调失败不得改变请求行为。

源码：[连接管理器](../../packages/ai/src/api/responses-session.ts)、[会话预热](../../packages/coding-agent/src/core/agent-session.ts)、[系统代理适配](../../packages/desktop/src/main/responses-proxy.ts)。

回归：[WebSocket](../../packages/ai/test/responses-websocket.test.ts)、[代理](../../packages/desktop/test/responses-proxy.test.ts)、[历史编辑与续接](../../packages/desktop/test/responses-message-actions.test.ts)。
