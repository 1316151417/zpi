# 消息如何变成模型请求

前置：[提供商和模型](providers.md)。这一页区分历史事实、当前上下文和发送 payload；三者不能直接互相覆盖。

## 统一消息模型

`zpi-ai` 用统一的消息和事件描述系统指令、用户内容、助手文本/推理/工具调用、工具结果、用量及停止原因。系统消息还记录工具的添加和移除。`normalizeContext` 和 transcript 辅助函数把历史投影成当前工具集合与有效对话，再交给具体协议。

跨模型重放要处理推理签名、工具调用 ID、未完成的工具结果和不同协议的内容块。原始历史保留来源信息，转换层只生成发送视图；否则切换一次模型就可能永久损坏另一协议需要的字段。

流式 UI delta 也不是最终历史。最终工具参数以完成事件为准；增量 JSON 解析只帮助展示部分输入，不能把尚未完整的参数当作有效工具调用。

## 三个适配器

| 协议 | 请求与转换责任 | 返回结果责任 |
| --- | --- | --- |
| Responses | instructions、input、function tools、推理/缓存/结构化输出 | output item、文本/推理/参数事件、最终 usage 和状态 |
| Chat Completions | messages、工具结果关联、模型兼容参数 | choices delta、finish reason、usage、工具参数收尾 |
| Anthropic Messages | system、content blocks、tool_use/tool_result、thinking、cache_control | SSE 内容块、thinking 签名、工具输入完成、停止原因 |

适配器使用同一套错误脱敏、Unicode 清理、媒体投影、用量和重试辅助函数，但协议差异留在各自文件中。不能把一个网关支持的特例当成全部提供商的默认能力。

## Responses 的请求细节

默认请求包含 `model`、`input`、`instructions`、`store: false`、`stream: true` 和 `reasoning.encrypted_content`。工具使用当前系统声明；函数 `strict` 为 false。便携的 JSON schema 输出配置转换为 `text.format`。请求可经过 `onPayload`，替换后仍校验 `input` 数组和流式要求。

SDK 客户端禁用内部自动重试，由 ZPI 的可观测重试层控制。会话标识通过 `session_id` 与 `x-client-request-id` 等 headers 传入，用户 headers 按合成规则处理；无 API key 时不伪造认证值。

ChatGPT 授权路径对工具加 `ZPI` namespace，并移除不适用的普通 API 字段，例如 temperature、top_p、max_output_tokens、background、conversation、metadata 等。`previous_response_id` 也先从普通 payload 中移除，只由连接管理器在证明可续接时添加。这避免任意调用者绕过上下文一致性检查。

HTTP 路径还兼容在流式请求下返回完整 JSON 的服务端。普通生成若既无输出也无有效 tokens，会抛出 `EMPTY_MODEL_RESPONSE`；预热 `generate: false` 不按空回答处理。

## Chat Completions 的兼容分支

system 可按 supportsDeveloperRole 转为 developer。助手工具调用与 tool result 保持批次邻接；工具结果中的图片投影成后续 user 图片消息，不能插到尚未配齐的工具结果中间。需要 reasoning_content 的模型仅复用适用同模型的推理内容。

输出上限字段可由 maxTokensField 指定，否则根据实现的模型规则选择 max_completion_tokens/max_tokens。支持时请求 include_usage；返回 usage 需验证为合法计数，cached_tokens 不能大于 prompt_tokens，再拆分普通 input 和 cacheRead。

工具流按 index 累加 ID、名称及原始 JSON，在 finish_reason 后才确认完整调用。缺少 finish_reason 是流异常；length 截断中的不完整 JSON 不执行。不能把容错解析器用于把截断副作用命令“补齐”。

## Anthropic Messages 的内容块

适配器处理 message_start、content_block_start/delta/stop、message_delta 和 message_stop。文本、thinking、redacted_thinking、tool_use 分别映射；签名保留给后续协议续接，redacted thinking 只显示占位，不把密文当作正文。

工具参数增量只累积字符串并发布预览，避免每个 token 都重新解析不断增长的大 write/edit JSON，造成二次方开销。content_block_stop 才解析并发送 toolcall_end；后续停止原因区分长度截断和无效参数。

兼容选项决定 eager tool input、长期缓存、工具 cache_control、空签名、strict tools、对话中 system/tool/effort 变更及 affinity headers。第三方 Messages 网关不默认拥有原生 Anthropic 的全部能力，预置会关闭部分选项。

thinking 可走 adaptive effort 或旧式 budget，显示可为 summarized/omitted；隐藏显示不意味着丢弃续接签名。message_delta 只覆盖实际出现的 usage 字段，避免代理省略 input_tokens 时把 message_start 的有效值归零；一小时 cache write 还保留独立计费明细。

## 缓存和上下文压缩不是一回事

缓存影响服务端计算复用及计费，不删除本地历史。Responses 的缓存 key 来自 session ID，最多 64 字符；`cacheRetention: none` 不发送这个 key。ChatGPT 路径只使用适用字段，不添加普通 API 的全部缓存控制。

当前代码按模型 ID 判断新旧缓存能力：显式缓存分支识别 GPT 5.6 及以后命名，支持 `prompt_cache_options` 和稳定前缀标记；旧模型分支按 allowlist 使用 long/short 保留值。这个判断是本仓库的兼容规则，模型命名或服务端能力变化时需要更新和测试。对旧协议省略 key 不等于关闭服务端所有自动缓存。

Anthropic 风格缓存分别处理 system、tools 和消息尾部；`skipCacheWrite` 可将标记留在更稳定的前缀。标记数量按协议块计数，最多四个，不递归修改工具 arguments 中恰好同名的业务字段。

## 结束和错误

`done`、`error`、`aborted`、`length` 的意义不同。长度截断不能当作正常完成；已执行工具必须有可恢复的结果记录。HTTP 原始字节、SSE 心跳和模型内容事件也不同，超时分类见[失败恢复](recovery.md)。

usage 中缓存读写从普通 input 拆出，推理 tokens 不重复加入 output。错误消息先提取结构化 status/code/Retry-After，再生成用户可读文本；不要把原始认证响应或 headers 直接输出到日志。

## 源码与回归入口

- [Responses](../../packages/ai/src/api/openai-responses.ts)、[事件](../../packages/ai/src/api/responses-events.ts)、[Completions](../../packages/ai/src/api/openai-completions.ts)、[Messages](../../packages/ai/src/api/anthropic-messages.ts)。
- [转换](../../packages/ai/src/api/transform-messages.ts)、[transcript](../../packages/ai/src/utils/transcript.ts)、[Responses 缓存](../../packages/ai/src/api/responses-cache.ts)、[通用缓存](../../packages/ai/src/utils/provider-cache.ts)。
- [Responses 兼容测试](../../packages/ai/test/responses-compat.test.ts)、[工具参数收尾](../../packages/ai/test/tool-input-finalization.test.ts)、[跨协议 ID 恢复](../../packages/ai/test/transcript-id-recovery.test.ts)、[媒体协议测试](../../packages/ai/test/media-policy-transports.test.ts)。
