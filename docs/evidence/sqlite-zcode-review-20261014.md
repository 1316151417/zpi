# SQLite 与 ZCode 对照复核（2026-10-14）

## 基线与范围

ZPI 基线为 `feat-sqlite` 的 `5417ad0986e8b10af454e4771c965a994282c8bb`（0.2.55）。本轮是正确性及回归复核，不是继续扩展功能；交付版本 0.2.56，只推送 feat-sqlite，等待人工验收后决定是否合 main。

ZCode 参照实际检出的 `aac4755666d09fdcd70272fcf063c077a639015f`（3.15.1），不是凭印象推断实现。其 app/host 任务索引和 CLI 存储有不同职责；这个版本的 CLI `SqliteSessionStore` 还包含 message/part 等表，不能简单概括成“正文始终都是 JSONL”。ZPI 保留已经选定的 SQLite 当前状态 + JSONL 对话事实方案，不照搬 ZCode 的全部存储架构。

## 确认并修复的问题

### 1. 迁移目标移动后仍被激活

复现：转换至 A，把整个目标目录改名为 B，然后在 B 激活。原实现会成功，但草稿等绝对附件引用仍指向 A。

修复：validate 在任何激活路径前验证 manifest 的 destination 与实际 final generation 位置相同。搬迁的 staging、ready 和已激活重试均拒绝；在原目标下从“staging 已重命名但指针尚未发布”恢复仍通过。不替用户猜测或重新写入所有历史路径。

### 2. 源目录别名未被重定位

复现：通过源目录的 symlink 别名进行迁移，草稿引用使用该别名。原实现只匹配 canonical source 的字符串前缀，迁移成功后引用仍留在旧源，旧源归档后失效。

修复：按真实路径确认受控引用归属，仅重定位 inventory 内允许的附件、输出、变更和上下文资产。外部项目引用保持不变，丢失的源内受控文件拒绝。回归同时确认源字节保持不变。macOS /var 与 /private/var 属于需要考虑的同类路径别名，真实 macOS 仍待验收。

### 3. Windows 迁移目录同步缺少平台保护

原迁移脚本无条件打开目录并 fsync，与运行时已有的 Windows 分支不一致。修复为相同平台策略，回归模拟 win32 分支；没有声称执行真实 Windows 测试。跳过目录 fsync 不等于 Windows 获得与其他平台完全相同的掉电保障。

### 4. 删除任务后可能被改名操作复活

故障注入：让附件清理失败。原实现先提交 SQLite 删除，随后清理异常中断内存移除；列表里仍保留任务，rename/upsert 会使其重新出现，并丢失 sessionFile 等私有状态。

修复：数据库提交成功后立即移除内存任务与其余所有者；已在删除事务清除的草稿不再二次写库。文件回收逐项执行，失败记录 `session.delete.cleanup`，逻辑删除仍完成。数据库删除失败则保留内存任务且不清理附件。回归覆盖列表、rename、重开与诊断日志。

## 实际参考的 ZCode 机制

- [迁移事务与 ready 发布](https://github.com/zai-org/ZCode/blob/aac4755666d09fdcd70272fcf063c077a639015f/apps/zcode-cli/packages/adapters/src/storage/session-store/migration-runner.ts#L158-L229)：BEGIN IMMEDIATE 后重新校验账本，提交后才 ready，异常回滚。启发本轮收紧迁移激活前的真实目标验证。
- [存储实例延迟交付](https://github.com/zai-org/ZCode/blob/aac4755666d09fdcd70272fcf063c077a639015f/apps/zcode-cli/packages/adapters/src/storage/session-store/sqlite-session-store.ts#L272-L291)：迁移成功前不把未准备好的 store 暴露给业务，失败关闭。
- [持久删除与内存状态顺序](https://github.com/zai-org/ZCode/blob/aac4755666d09fdcd70272fcf063c077a639015f/packages/services/src/zcode-agent/zcodeTaskServiceAdapter.ts#L3275-L3291)：删除事实与缓存/通知必须保持一致；归档删除明确先持久化成功再写 overlay。用于核对并修正 ZPI 删除提交后的状态处理。
- [条件式中断恢复](https://github.com/zai-org/ZCode/blob/aac4755666d09fdcd70272fcf063c077a639015f/apps/zcode-cli/packages/adapters/src/storage/session-target.ts#L301-L343)：恢复绑定原运行身份，避免重复结算。ZPI 继续使用自己的 accepted marker / 操作意图机制，不自动重跑不确定的输入或工具。

## 验证与限制

迁移新增回归先观察到预期失败，修复后 migration/generation 44 项通过；删除复现及相邻 Host 回归 14 项通过。另在 128 MiB V8 heap 限制下完成 100 MiB 合成数据迁移：inspect 约 1.62 秒、convert + validate 约 4.87 秒，maxRSS 286972 KiB。它是单次云端样本，RSS 不受 V8 heap 上限直接约束，不是目标平台性能验收。

最终冻结代码复跑：

- `npm run test:unit -- --maxWorkers=2`：退出码 0，171 个文件通过、1 个跳过；1388 项通过、2 项跳过，29.00 秒。
- `npm run check`：退出码 0，TypeScript / Biome 通过；保留 4 项 CSS `!important` 警告。
- `npm run build`：退出码 0；保留依赖 `use client` 指令提示。
- `git diff --check`：通过。

此前未完成的全量运行不计为通过；以上为重新启动后取得的完整结果。

仍未验证或未在本轮扩展的边界：

- 没有执行真实 macOS/Windows GUI、安装包、真实断电恢复。新增目录树的逐级目录持久化还需要专门的故障注入/平台验证，不能把文件 fsync 解释成完整递归目录耐久性。
- 直接输入的附件接受与 markUsed 之间存在待进一步故障注入的旧有窗口；对照 main 也有同样的调用顺序，本轮没有改造附件保留协议，不声称排除所有附件崩溃丢失风险。
- 上下文复核检查了 SDK snapshot/compaction/replace 契约；运行验证依赖本轮回归及完整测试，没有把局部源码阅读描述为所有历史切点的形式化等价证明。
- 文件清理失败可能留下已删除任务的孤立文件，保留错误诊断；本轮没有新增后台垃圾回收功能。
