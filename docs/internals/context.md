# 上下文、压缩与媒体预算

使用入口：[上下文管理](../features/context.md)。本页的压缩缩短模型输入；WebSocket 帧的 permessage-deflate 是[传输压缩](openai-websocket.md)，二者独立。

## 上下文不是全部历史

持久化 transcript 记录事实。模型上下文由系统指令、当前工具、最近压缩摘要、保留消息以及本轮输入组成。显示历史仍可翻到被摘要替代的消息。切换协议时进一步做兼容投影，发送前再应用媒体预算。

估算优先采用最近一次有效助手 usage，加上之后消息的估算值；没有 usage 时逐条估算。错误、取消或全零 usage 不作为可靠基准。界面的上下文估计不是服务端 tokenizer 的逐 token 结果。

## 基础提示与动态上下文

首条系统消息保存初始 `zpi.base` 和初始工具声明，不因后续上下文变化被重写。SDK 按块管理当前状态：

| 来源 | 上下文块 |
| --- | --- |
| 模板 preamble/rules、项目名和平台占位符、loader 基础指令、显式 `systemPrompt` | `zpi.base`；修改后追加替换 |
| 当前工具的简短说明、使用规则 | `zpi.tools`、`zpi.tool-rules` |
| 项目和用户 AGENTS/CLAUDE 指令文件集合 | `zpi.resources` |
| 额外指令，包括继承的项目指令 | `zpi.custom` |
| 当前技能目录和加载方式 | `zpi.skills` |
| 会话工作目录 | `zpi.environment` |
| 插件冻结的 instructions、插件当前上下文（Agent 清单、记忆等） | SDK 生成插件 ID 与本地块名组成的独立键 |

`systemPrompt` 回调只构造基础指令；资源、技能、插件上下文由 SDK 独立装配。`buildSystemPrompt` 是完整的可读预览，不用于重建模型请求开头。指令文件集合、技能目录各为一个块，块内变化替换该块全文，不做逐行差分。

插件的 `contextInstructions()` 只返回当前 `Record<string, string>`，不比较旧值、不写历史。SDK 在原有 prompt hooks 完成并刷新资源后比较状态；工具/Stop hooks 后的续轮通过现有 `prepareNextTurnWithContext` 比较。只有变化的块追加系统记录，字符串替换该块全部旧版本，缺失或空字符串生成 `null` 撤销标记。不同插件使用相同本地名称不会覆盖彼此；SDK 只管理 `zpi.*` 及自身分配的插件键，不撤销外部宿主的其他系统块。hook 的 `additionalContext` 仍是一次性的对话事实，不作为可替换状态去重。

最终请求保留更新的对话顺序：

```text
初始系统提示与工具声明
初始动态上下文
用户输入 → 助手回答／工具调用 → 工具结果
变化块的替换／撤销公告
下一条用户输入或模型续轮
```

OpenAI Chat Completions 在原位置发送 system/developer 消息；Responses 的 `instructions` 只含初始系统消息，后续更新位于 `input` 的 developer 消息。Anthropic 顶层 `system` 只含初始系统消息；支持会话中途 system 的模型使用原生 system，否则以 user 消息承载相同公告。初始块明确允许后续替换和撤销，包括以 user 消息承载的更新。公告统一在 AI 库渲染，适配层不再折叠动态状态到开头。外部消息若把更新放在工具调用和结果之间，仅将其延后到完整工具结果之后，不越过后续用户输入。

恢复和分叉从实际保留的 transcript 重放状态，不复用其他分支的内存去重基线。恢复初始化沿用已生效状态，等原有 prompt hooks 准备后再比较，避免尚未初始化的插件空值产生假撤销。压缩分别保存初始系统消息与最新上下文快照；重建顺序为初始系统、摘要、保留对话、上下文快照、压缩后的新消息。快照保留撤销标记，替换已压缩和保留段的旧系统更新，避免摘要和旧记录复活已撤销状态。多次压缩沿用同一机制，索引与完整历史读取的投影一致。

此机制保留未改变的提示与既有对话前缀，不保证服务端缓存命中。旧版本仍占用压缩前的请求 tokens；公告表达指令语义，不是服务端状态删除 API。工具 schema 通常仍在顶层发送当前集合，增删或重定义会影响缓存；Anthropic 原生工具变化也需要顶层声明可引用的工具。切换模型、推理设置、工具参数、媒体投影、压缩及 `onPayload` 自定义改写，都可能改变缓存或 WebSocket 增量复用条件。Anthropic 缓存标记随尾部移动，最多四个断点；TTL、最小长度、路由及实际命中由服务端决定。不新增旧提示聚合格式的拆分迁移或双轨兼容层。

## 自动和手动摘要

默认开启自动压缩，`reserveTokens = 16384`，`keepRecentTokens = 20000`。触发条件是估算上下文严格大于“模型窗口 − reserveTokens”。可按 `provider/modelId` 配置覆盖值，非负整数包括 0 都有意义。

摘要前先找有效切点，从后往前保留约 keepRecentTokens。切点只能落在上下文可见的用户类消息或助手消息边界；工具结果不能随便与对应调用拆开。特别长的一轮可以拆分，额外生成这一轮前缀摘要，保留后缀继续执行。

压缩准备会合并已有摘要、待压缩历史、保留起点和文件操作集合。摘要要求保留目标、进度、决定、后续步骤、关键路径与错误信息。写入 compaction entry 后，后续上下文由摘要和保留段重建，并重放必要系统状态。

手动压缩也调用模型并消耗 tokens；取消或失败不能发布一个不存在的成功边界。摘要生成本身如果超窗，仅对这一次摘要请求做有界裁剪，最多三次；媒体过大走摘要专用媒体投影。真实 transcript 不被这类请求修复覆盖。

## 轻量清理 microcompact

默认关闭，且总压缩关闭时不会启用。它不调用模型，把旧工具结果正文替换成 `[Old tool result content cleared]`，保留调用关联和边界记录。

默认时间阈值 60 分钟；token 阈值可配置，默认推导值为 `min(floor(自动压缩阈值 × 0.9), 自动压缩阈值 − 2000)`，下限 0。默认至少节省 256 tokens 才生效，保留最近五组有候选结果的工具批次，而不是简单保留五条文本。

工具白名单兼容 ZPI 的小写内置名称。默认不清理错误结果、媒体结果、重复 ID 引起歧义的结果或已经清理过的结果。边界保存 cleared/kept call IDs，重放时再次排除有歧义的重复 ID 和媒体，防止清错后来的结果。

## 压缩后的文件读取状态

read 建立的已读状态用于避免向模型重复返回未变化的同一区间。摘要或 microcompact 改变可见上下文后，会清空这份状态，保证再次读取能拿到正文。它不是编辑权限锁：edit 另外检查匹配和准备期间的外部变化，并不强制每次编辑都先调用 read。

## 图片和其他媒体

输入处理先识别文件类型、尺寸和解码预算；扩展名或 Content-Type 不是唯一依据。原始图片和发送投影分开：图片缩放、格式转换、数量/体积限制在请求边界执行，超限会报告压缩、遗漏或失败原因。

媒体政策由模型能力和协议共同决定。图片、视频、PDF 文件块的适配能力不一致；不支持的媒体不能当成乱码文本塞进 messages。媒体过大错误可以生成更小的请求投影，不能无限重复同一大 payload。

### 单张图的压缩

图片校验、解码、方向校正、缩放和编码使用 Sharp；BMP 经受限解析后把像素交给 Sharp。非 WebP 完整解码首帧一次，再复用原尺寸像素产生候选；JPEG 同尺寸的不同质量尝试还复用缩放及黑底合成结果，只保留当前尺寸候选。

默认最大边长 2000 像素。read 的独立图片 token 预算为 25000，按 `base64 字符数 × 0.125` 估算，相当于最多 200000 base64 字节；模型 maxTokens 是输出上限，不能拿来替代这个预算。普通附件没有这一额外 token 限制，默认 base64 上限 5 MiB。原始文件大小、原始像素、编码字节与模型输入预算分别校验。

原图在尺寸/预算内优先保留。需要压缩时，JPEG 质量依次尝试 80/60/40/20；基于受限尺寸候选分别尝试 0.75、0.5、0.25 倍，比例不是累积相乘；再按原图尝试最长边 1000/800/600/400/300/200 的 quality 20 JPEG 兜底。每次编码后重新检查预算，首个合格候选即停止。

PNG 仅做一次原尺寸无损优化（compressionLevel 9 与 adaptiveFiltering），后续可走 JPEG；GIF 等保格式分支按实现顺序尝试，动画改码只发送首帧。WebP 是特殊的预算内原字节透传，超限报 unsupported，不因 Sharp 能转码就自动转码。关闭自动缩放仍保留预算检查，不能作为绕过限制的开关。

压缩结果带格式、尺寸、动画与可读性提示。压到 200px 或质量 20 可能让小字和按钮不可读，编码成功不等于视觉信息完整；无法满足预算时提供明确 omission/error，不能声称模型已看到了图片。

### 整次请求的媒体投影

默认媒体 data URL 总预算 40 MiB，统计的是 inline 媒体，不包含全部文字、工具 schema 和 JSON，因此不是整个 HTTP body 的硬上限。

先保护最近一条真实用户消息的附件；它们本身超预算时返回可恢复的 `MEDIA_BUDGET_CURRENT_ATTACHMENT_TOO_LARGE`，要求减少附件。其余媒体从新到旧保留连续后缀，遇到一张放不下就停止，不再挑更早的小图填空；被省略的块替换成稳定文字占位。

每次请求从真实历史重新投影，不修改附件或 transcript。固定保护集合与追加历史条件下，旧图不会在同一循环中反复复活；新用户输入改变保护集合后不承诺同样单调性。移除早期媒体会改变缓存前缀，也可能使 WebSocket 必须全量发送。


## 源码与回归入口

- [压缩算法](../../packages/coding-agent/src/core/compaction.ts)、[摘要序列化](../../packages/coding-agent/src/core/compaction-utils.ts)、[microcompact](../../packages/coding-agent/src/core/microcompact.ts)、[配置](../../packages/coding-agent/src/core/settings-manager.ts)。
- [媒体政策](../../packages/ai/src/utils/media-policy.ts)、[输入图片](../../packages/coding-agent/src/core/images.ts)、[图片限制](../../packages/coding-agent/src/core/image-limits.ts)、[压缩候选](../../packages/coding-agent/src/core/tools/pi/utils/image-resize-core.ts)、[图片预算](../../packages/coding-agent/src/core/tools/pi/utils/image-budget.ts)、[上下文拆分计量](../../packages/ai/src/utils/context-breakdown.ts)。
- [切点测试](../../packages/coding-agent/test/compaction-boundaries.test.ts)、[microcompact 测试](../../packages/coding-agent/test/microcompact.test.ts)、[摘要媒体重试](../../packages/coding-agent/test/compact-media-retry.test.ts)、[媒体会话测试](../../packages/coding-agent/test/media-request-session.test.ts)。
