# 后台历史写入与超长单回合回归

2026-10-28，工作树基于 0.2.207。历史追加、文件同步、冷索引重建及新 generation 的批量校验/索引/写入已移到专用 Node Worker。主线程通过只读连接使用独立 `history.sqlite`，权威业务库仍是 `state.sqlite`。JSONL 仍是会话事实来源。

## 持久化与故障覆盖

- 同一会话的追加、压缩和替换共用串行写入队列；确认前不推进主线程水位、不发布消息、不执行工具。
- 持有历史库的 SQLite 写锁时，主线程定时器及独立业务库写入仍可完成。释放锁后才确认历史写入。
- 并发追加保持完整 parent 链；替换期间的后续追加排在新 generation 后，不丢失记录。
- 索引失败保留已经持久化的 JSONL 尾部，禁止继续追加；重新打开只补建一次，不重放工具。
- 批量输入迭代失败、校验失败和 generation 发布失败保留旧历史；清理失败整体回滚并允许重试，包括没有文件/水位的索引残留。
- Worker 退出拒绝待确认请求；正常退出排空运行与写入队列，并关闭数据库和线程。
- 最新回合查询使用单行 SQL，避免遗留只读游标使主线程停留在旧 SQLite 快照。

对应回归见 `packages/desktop/test/history-worker.test.ts`、`history-write-barrier.test.ts`、`storage-host-recovery.test.ts`、`storage-cleanup.test.ts` 和 `task-workflow-recovery.test.ts`。

## 单回合覆盖

`packages/desktop/test/long-single-turn.test.ts` 使用同一个 run 的 160 组工具步骤和每条 64 KiB 工具结果，验证后台冷重建、按调用分页、约 2 MiB 页预算、游标推进、完整块顺序、无重复/缺失、首中尾搜索及重新打开。另用超过 2 MiB 的单条中文结果验证软预算的单记录例外、8 MiB 硬上限和后续追加保真。

真实隐藏 Electron 用例 `tests/desktop/long-single-turn.spec.ts` 使用同一个 run 的 160 组工具步骤和每条 16 KiB 工具结果，覆盖初次分页、首中尾查找高亮、合并后仍只有一个历史回合、自动压缩、实时续写、IPC 快照、取消、重启及不重放模型请求。它没有证明任意长度的单条 Markdown 都能在固定帧预算内渲染。

```sh
npm run test:unit -- packages/desktop/test/history-worker.test.ts packages/desktop/test/history-write-barrier.test.ts packages/desktop/test/long-single-turn.test.ts
npm run test:desktop -- tests/desktop/long-single-turn.spec.ts tests/desktop/history-auto-load.spec.ts tests/desktop/side-chat.spec.ts tests/desktop/message-actions.spec.ts
node --import tsx scripts/benchmark-history-worker.ts 100
```

## 100 MiB 测量

本机 Apple M4，macOS Darwin 24.1.0，Node v24.12.0。合成样本为 **100.0066 MiB、1 个 run、1,575 次工具调用、6,303 条记录**。使用真实 SQLite/JSONL；没有模型网络请求。每阶段一个样本，OS 缓存未清理，基线先于 Worker 测量；这次测量没有并行运行本任务的 GUI 或全量测试，也没有控制系统其他负载。

用主线程每 5 ms 的定时器观测最大实际回调间隔，包含 OS 调度和测量结束后的尾部机会。它不是 Electron 帧延迟，也不是严格的全部主线程任务耗时。

| 阶段 | 总耗时 | 主线程最大定时器间隔 |
| --- | ---: | ---: |
| 原路径冷索引重建 | 1,046.9 ms | 13.6 ms |
| Worker 冷索引重建（含启动） | 2,280.5 ms | 28.6 ms |
| 原路径批量替换 | 1,343.4 ms | 1,343.6 ms |
| Worker 批量替换 | 1,712.4 ms | 7.7 ms |
| Worker 暖打开及首屏投影 | 7.9 ms | 8.0 ms |

批量替换不再形成约 1.34 秒的主线程长阻塞，但总耗时增加约 27%，包含逐记录传输与临时 spool 的成本。冷重建这次样本没有显示耗时或定时器指标改善；原加载路径本就按 chunk 让出事件循环，Worker 启动及跨线程调度有额外成本。不能据此宣称全部启动路径都更快。

暖打开首屏只读取 **666,005 字节**，包含最近 10 次调用、10 个工具块，不物化整段 100 MiB 历史。脚本也输出进程 RSS 端点；同一进程包含基线、Worker、SQLite 缓存及 GC 波动，端点不是阶段峰值，不能作为线程独立内存占用。

本次验证不包含发行包、系统掉电、真实供应商网关或 1 GiB 单回合 GUI 压测。历史页读取、上下文物化、请求序列化和 Markdown 渲染仍有主线程/renderer 成本；没有压缩时，发送模型前仍需完整有效上下文。逐记录确认保留有界的在途内存，暂未采用需要额外主线程序列化估算的批次传输。

## 验证记录

- `npm run check` 通过；保留原有样式 `!important` 警告及 6 项既有提示。
- `npm run test:unit`：333 文件、4,214 项通过，1 项跳过。最后的索引清理事务另以 17 项存储专项验证通过。
- `npm run build` 通过，产物包含 `history-worker.js`。
- 上述四个桌面文件：11 项通过，使用共享隔离启动器运行真实隐藏 Electron。
- simplify 四角度审查已完成；复用追加输入类型与 generation 接管逻辑、合并追加构造/发布流程、移除多余的同步/异步回滚签名，并去掉每次追加确认的路径解析。保留逐记录传输；直接复用复制 spool 需扩展导入合同，本次未扩大该接口。
