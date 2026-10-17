# 深度 Bug 排查报告（bugs-by-mimo）

- 排查时间：2026-10（版本 0.2.96，commit `688b8e8`）
- 环境：macOS（APFS 大小写不敏感）、Node.js 24、`npm run test:unit` / `npm run build` / Playwright GUI 测试
- 结论：发现 **14 个可实证的缺陷**（4 个中高危、10 个中低危），另有 7 个存疑项。`npm run test:unit` 当前在本机是红的（3 个测试文件失败，均为真实缺陷而非测试误报）；quick chat 的 Electron GUI 测试 3/3 全部失败。最严重的是 `packages/ai` 的 SSE 解析器在网络分包边界上会损坏整个回复流。

## 排查方式

- 全量运行 `tsc`/Biome、3030 个单元测试、`npm run build`、Playwright GUI 测试（quick chat 部分）。
- 4 个并行审查代理分别通读 `packages/coding-agent` + `packages/agent`、`packages/ai`、`packages/desktop/src/main`、`packages/desktop/src/renderer` + `packages/ui`（约 6.7 万行源码）。
- 对可疑点用独立脚本（`/tmp/zpi-bug-repro/`、`/tmp/ai-audit/`）直接调用产品代码复现；关键结论二次抽验。
- 临时插桩（测试采样、`createSession` 堆栈追踪）均已还原，工作区干净。

---

## 一、中高危（建议优先修复）

### 1. SSE 流解析：`\r\n` 被网络分包截断时整个回复失败（高危）

位置：`packages/ai/src/api/anthropic-messages.ts:395-421`（`consumeLine` / `nextLineBreakIndex`）

当读缓冲恰好以 `\r` 结尾（CRLF 换行的后半段 `\n` 在下一个网络分包到达）时，`\r` 被当作完整行结束符消费，下一分包开头的 `\n` 被解析成空行——而空行正是 SSE 的事件派发信号。结果是事件被提前派发（`data` 为空），后续 `data:` 变成无类型事件，整轮直接报错。实测（同一条 Anthropic 流，仅分包边界不同）：

```
单分包（CRLF）            → stop, text: ["Hello"]        正常
LF 换行、同样分包位置      → stop, text: ["Hello"]        正常
CRLF 对跨分包截断          → error: Could not parse Anthropic SSE event
                             message_start: Unexpected end of JSON input
```

TCP 可在任意字节间分包，Anthropic 兼容服务端用 CRLF 很常见，因此长流上会**概率性整轮失败**。加重因素：`flushSseEvent`（`packages/ai/src/api/anthropic-messages.ts:353`）违反 SSE 规范派发了空 `data` 事件。现有测试全部用单字符串构造 SSE（`createSseResponse`），从未覆盖分包边界。

修复方向：缓冲区末尾悬空的 `\r` 应等到下一字节到达再判定；空 `data` 事件不应派发。

复现：`/tmp/ai-audit/sse-crlf-split.mts`（`npx tsx` 运行）。

### 2. `process.getSystemVersion()`（Electron 专有）炸掉单元测试启动，22 个凭据安全测试在 macOS 上全部跳过

位置：`packages/desktop/src/main/index.ts:216`；受害者 `packages/desktop/test/web-credentials-ipc.test.ts:130`

`launch()` 里无保护地调用纯 Node 中不存在的 `process.getSystemVersion()`（仅 `platform === "darwin"` 分支命中，即 macOS 开发机）。错误被吞进 `main.startup` 日志后 `loadRenderer` 不再执行，`web-credentials-ipc.test.ts` 的 `beforeAll` 超时，**22 个覆盖凭据显隐、IPC 鉴权的安全测试从未运行**。产品运行时不受影响（Electron 里有该 API），但文档要求的 `npm run test:unit` 在 macOS 上是红的，安全回归完全裸奔。

```
npx vitest run packages/desktop/test/web-credentials-ipc.test.ts
# → expected "vi.fn()" to be called once, but got 0 times
# 启动日志: TypeError: process.getSystemVersion is not a function at launch (index.ts:216)
```

修复方向：`process.getSystemVersion?.() ?? "0"`，或在测试环境打桩。

### 3. 自定义命令扫描条目上限：结果取决于文件系统枚举顺序（无序、不可复现）

位置：`packages/desktop/src/main/custom-commands.ts:485-498`（`list()` → `visit`）

`list()` 用 `fs.opendir` 原始枚举顺序计数，超限 `break` 后**仍处理已收集的条目**。`fs.opendir` 不排序（实测创建顺序 `a.md, b.md, nested`，枚举顺序是 `[b.md, nested, a.md]`），所以超限时**哪些命令存活完全由文件系统决定**——同一目录在 macOS 与 Linux 上可能显示不同命令子集，且两次扫描可能不一致。测试契约（`packages/desktop/test/custom-commands.test.ts:512-514`）要求截断时返回空列表 + `scan_limit`（不完整扫描不可信），实际返回 `[b.md]`：

```
npx vitest run packages/desktop/test/custom-commands.test.ts
# → expected [ { id: 'b.md', … } ] to deeply equal []
```

独立复现：`/tmp/zpi-bug-repro/repro-custom-commands.mts`（`npx tsx` 运行，输出 `commands kept: [ 'b.md' ]`）。

修复方向：超限即放弃已收集条目（与同目录下 `assertNameAvailable` 的 fail-closed 策略一致）。

### 4. Edit 工具把唯一匹配误判为重复，拒绝合法编辑

位置：`packages/coding-agent/src/core/tools/pi/edit-diff.ts:247-253`（`countOccurrences`）

匹配在**精确空间**成功后（`fuzzyFindText` 返回 `usedFuzzyMatch: false`），唯一性检查却在**模糊归一化空间**（NFKC + 引号/破折号折叠 + 去行尾空白）计数。归一化是有损投影，`"foo "`（带尾空格）在文件里只出现一次也会被数成 2 次，报错 "Found 2 occurrences… provide more context"——错误信息误导模型进入重试循环；含弯引号/长破折号的 `oldText` 在普通 Markdown 里几乎必然触发。反方向也会漏：折叠可把两个不同出现合并成一次，真正的重复反而放行。实测：

```
applyEditsToNormalizedContent("foo \nbar\nfoo\n", [{ oldText: "foo ", newText: "FOO " }], "t.txt")
# → THREW: Found 2 occurrences of the text in t.txt.（实际唯一）
```

复现脚本：`/tmp/zpi-bug-repro/repro-edit-fuzzy.mts`。修复方向：匹配用哪个空间，计数就用哪个空间（`usedFuzzyMatch === false` 时用 `content.split(oldText)`）。

---

## 二、中低危

### 5. SSE 异常退出时不取消响应体，连接泄漏（中）

`packages/ai/src/api/anthropic-messages.ts:478-480`：任何异常退出（SSE `error` 事件、解析失败等）只 `releaseLock()`，从不 `reader.cancel()`。undici keep-alive 下 socket 被占住直到超时/GC，重试风暴时累积。复现脚本 `/tmp/ai-audit/sse-body-leak.mts` 确认 `cancel() called: false`。

### 6. 未知 `stop_reason` 把已完成的回复打成失败（中）

`packages/ai/src/api/anthropic-messages.ts:1606-1608`：注释写"优雅处理新增枚举值"，代码却 `throw`。文本和工具调用都已收全的回复被转成 `stopReason: error`，且错误信息不匹配 `isRetryableAssistantError`——上层可能重跑整轮、重复计费。应降级为 `stop`。

### 7. quick chat 图片内存预算重复计数（中低）

`packages/desktop/src/main/quick-chat-attachments.ts`：`markUsed()` 把已用图片字节累加进 `historyBytes`，但条目仍留在 `entries` 里，`bytes()` 遍历 `entries` 时**再算一遍**。每张已发送图片双重计费，128 MB 上限实际缩水约一半，触发过早的 "busy: 临时图片内存已达上限"。实测 `bytes()` 在 `markUsed` 后凭空多出一倍的 `image.data.length * 2`。复现：`/tmp/zpi-bug-repro/repro-image-budget.mts`。

### 8. 命令导入跳过原因在大小写不敏感文件系统上分类错误（低）

`packages/desktop/src/main/command-import.ts:221-229`（`conflict()`）：先 `lstat` 后查名字集；macOS 默认 APFS 大小写不敏感，`lstat(target/REVIEW.md)` 命中刚导入的 `review.md`，导致本应报 `sameNameExists`（"所选批次内重名"）却报 `targetExists`（"目标已有文件"）。跨平台行为不一致，用户看到的跳过原因是错的（跳过决策本身正确）。测试 `packages/desktop/test/command-import.test.ts:210` 在 macOS 上确定性失败。

复现：`/tmp/zpi-bug-repro/repro-command-import.mts`。修复方向：先（或同时）按 `nameKey` 检查批内重名，区分精确目标名与大小写折叠名。

### 9. 重复 tool-call ID 会让会话永久无法重新打开（低，触发少但后果持久）

`packages/coding-agent/src/core/streaming-tool-journal.ts:238-240`：流式解析器不去重工具调用 ID，本地量化模型发出重复 ID 后转录被持久化，下次 `createAgentSession` 恢复时 `unresolvedCanonicalToolCalls` 直接 throw——会话从此打不开。恢复逻辑本可修复（它已为缺失结果合成回执）却选择了拒绝；`transformMessages` 构造请求时同样会丢弃其中一个结果。

修复方向：摄入时去重/修复 ID，或让 `unresolvedCanonicalToolCalls` 宽容处理（首个配对，多余视为惰性）。

### 10. quick chat GUI 测试 3/3 全红（低-中，测试债但暴露两个真实问题）

`node scripts/test-desktop.ts tests/desktop/quick-chat.spec.ts` 确定性 3 失败（`tests/desktop/quick-chat.spec.ts`）：

- 两个失败：对主 composer 用 `toHaveValue`，但 composer 是 contenteditable 的 `packages/ui/src/components/MentionEditor.tsx:298`，该断言永远不可能通过（"Not an input element"）。
- 一个失败：`before` 快照与 `packages/desktop/src/renderer/store.ts:623-635` 启动时 `initialize()` 自动 `newSession()` 竞态——快照后主会话列表凭空多出 `draft: "新对话"` 记录（经插桩抓栈实锤是启动路径的 `createSession` IPC）。断言语义本身没问题，是快照时机有竞态。

这些 spec 自 0.2.89（`0a2e424`）引入，提交记录写明 "Native Mac GUI not tested"，等于 quick chat 的 GUI 测试从未绿过。

### 11. `repairJson` 不修复非法 `\u` 转义（低）

`packages/ai/src/utils/json-parse.ts:62-77`：`\A\H` 能修复，`\u12z4`、`C:\user\x` 却原样放行后抛错——同类损坏一半救一半不救，直接影响工具入参容错（`parseJsonWithRepair`）。

### 12. 1h 缓存写入计费拆分不刷新（低）

`packages/ai/src/api/anthropic-messages.ts:809-832`：`message_delta` 只更新 `cacheWrite` 不更新 `cacheWrite1h`，而 `packages/ai/src/utils/cost.ts:20-22` 对 1h 写入按 2 倍价计费。代理类服务只在 delta 报明细时，1h 写入被按 5 分钟价少计费。

### 13. `StreamOptions.onRetry` 是死回调（低）

`packages/ai/src/types.ts:299` 声明、`openai-completions.ts:47` / `openai-responses.ts:111` 白名单放行，但 `packages/ai/src/utils/provider-retry.ts:118-133` 从不调用——想做重试提示的调用方静默无效。接线或删除。

### 14. thinking 预算钳制在上下文将满时产生非法请求（低）

`packages/ai/src/api/anthropic-messages.ts:1195`（`budget_tokens: options.thinkingBudgetTokens || 1024`）与钳制逻辑 `:1131`：`max_tokens` 被压到 1024 以下时 `|| 1024` 把预算复活成 `budget_tokens: 1024 > max_tokens`（Anthropic 拒绝 400）；`reasoningConfig` 路径（`:1016`）则发 `budget_tokens: 0`（低于 1024 下限）。恰好在上下文最紧张时发生。

---

## 三、存疑项（未实证，供参考）

1. `packages/desktop/src/main/index.ts:1229-1252`（before-quit）：服务 dispose 抛错会被误报为"草稿未保存，已取消退出"，可能半拆解后继续运行。
2. `packages/agent/src/agent-loop.ts:105-109`：`reset` 替换流式协调器时旧实例不 `detach()`（仅自定义 SDK 流可触发）；二次 `reset` 会覆盖 `streamed` map。
3. `packages/ui/src/reducer.ts:366-390`（`mergeHistory`）与 `packages/desktop/src/renderer/store.ts:395`（`accept`）组合，在极窄竞态（快照 seq ≥ live seq 且历史被重写）下可能复活已删除块。
4. `packages/desktop/src/main/pane-services.ts:31-50`：12 终端上限检查跨 `await`，并发可超 1 个。
5. `packages/desktop/src/main/worktrees.ts:71-79`：`git worktree add` 失败时部分检出残留磁盘，重试会累积。
6. `packages/coding-agent/src/core/compaction.ts:175-177`：压缩后 usage 估计可能返回 0，静默关闭自动压缩（仅当最后一次 assistant 无 usage）。
7. `packages/coding-agent/src/core/tools/pi/read.ts:170`：空文件 `offset: 1` 报错而无 `offset` 返回空——边缘行为不一致。
8. 其他小项：`guard-model-stream.ts:55` 失败路径把流式 scratch 字段带进错误消息；`openai-responses.ts:373-376` 的 `cost.total` 依赖属性插入顺序；`input-queue.ts:141-145` `delete` 只等待当前挂起操作；preload `onBeforeQuit` 单监听器注册会被覆盖（现仅一个消费者，属潜在陷阱）。

## 四、排查过且未发现问题的部分

- 全部约 120 个 IPC 方法的 main/preload/renderer 契约（参数个数、顺序、返回结构）逐一比对一致；`zpi:prepare-quit`/`zpi:drafts-flushed` 握手无泄漏。
- Markdown XSS 路径（rehype-sanitize + 链接协议白名单，`javascript:`/`data:text/html` 无法到达 `href`/`src`）。
- 纯逻辑模块模糊测试：`find.ts`（约 2.1 万例，含 `İ` 等折叠变长字符）、`patch-find.ts`（对照 `@pierre/diffs` 元数据）、`readTextRange`（2 万例）、CRLF 编辑路径（5 千例多编辑）均一致。
- 后台任务/进程看门狗与 `settle` 清理、state-store 的修订/审计/意图日志/墓碑语义、storage 清理的符号链接与所有权防护、`input-queue` 序列化、React hooks 的清理与卸载后 setState 检查：未见缺陷。
- Anthropic 工具入参增量拼接契约、UTF-8 分包解码、usage 计算、`provider-retry` 的 abort/监听器清理：核对正确。

## 五、建议修复顺序

1. **#1** SSE 分包解析（直接影响每次对话的稳定性）
2. **#2 / #3** 测试红灯与扫描确定性（`npm run test:unit` 恢复绿灯）
3. **#4** edit 工具唯一性检查（影响编辑命中率与模型重试循环）
4. 其余按序。#2、#8 仅在 macOS 暴露，但项目以 macOS 为开发与发布平台，建议一并处理。

## 附：复现脚本索引

| 脚本 | 对应发现 |
| --- | --- |
| `/tmp/ai-audit/sse-crlf-split.mts` | #1 |
| `npx vitest run packages/desktop/test/web-credentials-ipc.test.ts` | #2 |
| `/tmp/zpi-bug-repro/repro-custom-commands.mts` | #3 |
| `/tmp/zpi-bug-repro/repro-edit-fuzzy.mts` | #4 |
| `/tmp/ai-audit/sse-body-leak.mts` | #5 |
| `/tmp/ai-audit/stop-reason-and-cache.mts` | #6、#12 |
| `/tmp/zpi-bug-repro/repro-image-budget.mts` | #7 |
| `/tmp/zpi-bug-repro/repro-command-import.mts` | #8 |
| `node scripts/test-desktop.ts tests/desktop/quick-chat.spec.ts` | #10 |

> 注：`/tmp` 下的脚本为排查时的临时产物，机器重启后可能丢失；如需长期保留可迁入 `scripts/` 或测试夹具。
