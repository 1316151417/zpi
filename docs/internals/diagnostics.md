# 错误、性能与用量计量

使用入口：[故障排查](../features/diagnostics.md)。重试规则见[恢复](recovery.md)。

## 错误流向

提供商错误先提取结构化 status、code 和重试信息，移除认证和敏感原文，再映射到模型事件及用户提示。工具错误作为 toolResult 保存；主进程基础设施错误则阻止不能安全推进的操作。UI 不应把所有错误都简化为“网络不好”。

本地错误日志单文件约 5 MiB，保留一份轮转备份。renderer 和 main 都通过专门入口记录，有上下文标识而不输出完整请求凭据。Responses 的诊断记录连接/回退/完成等摘要，不记录正文、token 或可直接复用的 response ID。

## 等待和卡顿

模型等待提示在约 15 秒出现，不代表自动超时。首事件与事件空闲阈值见恢复页。UI 应区分等待模型、工具执行、重试倒计时、提问和停止中的状态。

性能诊断观察 renderer 长帧（约 200 毫秒）、事件批次（约 50 毫秒）和 main 事件循环（约 250 毫秒），按约 10 秒摘要。隐藏窗口不按前台长帧报警，机器休眠造成的时钟跨度要重置。这些记录保留本地，不是遥测。

## 用量和性能不是同一个统计

已知输入、输出、缓存读写、推理与费用按请求结果汇总。失败请求如果返回了真实用量仍可计入消耗；无法获得的数字不能补成“确定没有花费”。计费参数来自模型配置，显示金额是估算。

TTFT 从请求开始到首次非空文本、推理或工具内容，平均值按有效样本算术平均。输出速度使用总输出 tokens 除以累计有效输出时长，不能简单平均每次 TPS。失败、取消或长度截断样本不进入成功性能均值。

一次模型请求结束形成一个 step；内部 HTTP 重试不额外增加模型 step。摘要压缩属于会话模型消耗；子智能体和标题生成不会重复计入父任务性能，记忆也有独立运行边界。

## 辅助对话基线

辅助对话继承父上下文时保存一次明确的计量基线及历史水位；后续自身增量独立累加。不能每次打开面板又把父用量叠加一次，也不能在父任务继续运行后偷偷扩大继承基线。

源码：[错误日志](../../packages/desktop/src/main/error-log.ts)、[主进程诊断](../../packages/desktop/src/main/performance-diagnostics.ts)、[renderer 诊断](../../packages/desktop/src/renderer/performance-diagnostics.ts)、[AI 计量](../../packages/ai/src/utils/model-performance.ts)、[会话计量](../../packages/coding-agent/src/core/model-performance.ts)。回归：[性能](../../packages/ai/test/model-performance.test.ts)、[会话性能](../../packages/coding-agent/test/session-performance.test.ts)、[诊断](../../packages/desktop/test/performance-diagnostics.test.ts)、[错误脱敏](../../packages/ai/test/provider-error-redaction.test.ts)。
