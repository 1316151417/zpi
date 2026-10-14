# SQLite 存储分支验收记录（2026-10-14）

状态：开发验证分支 `feat-sqlite`，版本 0.2.54；等待用户在 macOS 人工验收后决定是否合入 main。本次没有迁移用户真实数据。

## 范围与集成基线

- 原始 main 基线：`2a912a41970122de70aee7079c79263fb2fad605`（0.2.50）。
- 开发期间合入 main 0.2.51、0.2.52，并继续合入 `6fafb1329d17836bd24ee9fa4de8afbd51657aaf`（0.2.53）的快捷键、环境菜单改动。
- SQLite 保存当前业务状态；JSONL v2 保存对话事实；操作审计保存摘要并有保留上限。历史格式仅由离线工具转换，运行时不双读。
- 继续任务使用 SQLite 偏移索引和上下文 checkpoint。编辑、fork、队列接受通过操作意图和原文件保留处理跨文件边界。
- 实现与隔离试用步骤见 [存储指南](../specs/sqlite-storage.md)。

## 大样本实测

以下是云端临时合成数据，单次测量，不是 macOS、冷缓存或 p95 验收。

- 压缩后的 100 MiB / 1 GiB 会话：打开校验读取 1 字节；恢复约 5 MiB 有效上下文读取约 5.08 MiB，解析 82 条。详见 [报告](../storage-lazy-restore-benchmark.md) 与其原始数据。
- 无压缩且全部内容仍有效的 1 GiB 会话：首次构建模型上下文仍读取全部有效历史，RSS 增长约 1175 MiB。这不是恒定内存承诺；没有静默截断历史。
- 迁移用临时 SQLite spool 代替整份 JSONL 数组：100 MiB / 1 GiB 样本的 maxRSS 分别约 319 / 340 MiB。
- 1 GiB 迁移在 `--max-old-space-size=128` 下通过：inspect 约 19.41 秒，convert + validate 约 89.35 秒，maxRSS 222592 KiB（约 217 MiB）。V8 heap 限额不等于进程 RSS 上限。
- 100 MiB 全 system、未压缩历史在相同 128 MiB heap 下通过，maxRSS 264432 KiB；无临时 spool 残留。
- 复现工具：`scripts/benchmark-storage-migration.ts`；只生成并清理自有临时样本，不使用真实任务。

## 构建与平台边界

发现并修复 tsup 默认把 `node:sqlite` 转成 `sqlite` 导致构建产物无法导入的问题。main / preload 构建保留 Node 协议，并加入实际 bundle 回归测试。

实际 Electron 41.10.7 二进制通过 `ELECTRON_RUN_AS_NODE=1` 加载打包后的 StateStore，验证 WAL、synchronous=FULL、写入、关闭、重开读取。这是 Electron Node 模式验证，不能替代 Electron GUI、macOS 钥匙串、全局快捷键或安装包测试。

## 已知边界与人工验收

- JSONL 与 SQLite 不构成单个跨文件事务；未决意图保留并阻止不安全重放，部分故障需要人工检查。不会自动重跑不确定是否执行过的工具。
- 历史 generation 文件保留用于故障排查；本次不实现物理垃圾回收。附件索引和 fork 附件路径映射仍随附件数量增长。
- 凭据文件与 SQLite 的异常回滚不是掉电时的跨文件原子提交。Windows 目录 fsync 限制已在实现文档说明。
- 迁移 validate 对照同一转换适配器并检查数据库、内容、引用与状态；不能冒充独立语义实现的全切点差分证明。
- GUI 与目标平台发行包尚需人工验证。先使用独立 `ZPI_DATA_DIR` 和测试项目；旧数据用只读来源、副本目标、inspect / plan / convert / validate / activate 流程。保留来源备份，不能把权威 state.sqlite 当缓存删除。

## 最终命令结果

合入 0.2.53 后，0.2.54 工作树的最终复验结果：

- `npm run test:unit -- --maxWorkers=2`：退出码 0；171 个测试文件通过、1 个跳过，1359 项通过、2 项跳过，耗时 111.59 秒。
- `npm run check`：退出码 0；TypeScript 通过，Biome 检查 594 个文件；保留 4 项现有 CSS `!important` 警告。
- `npm run build`：退出码 0；保留第三方依赖的 `use client` 指令提示。
- `git diff --check`：通过。
- Electron GUI / Playwright 桌面验收未运行，不包含在上述单测数量中。
