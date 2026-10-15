# SQLite 存储（实施分支）

本文描述当前代码与人工验收方法，不表示目标平台、打包版本或性能预算已经验收。不要把旧架构计划中的建议字段、命令别名或预算当成实现结果。

## 权威来源与文件布局

应用数据根保留错误日志、运行锁和活动指针：

```text
<userData>/
  active-generation.json
  .storage-lock/owner.json       # 运行时持有；正常退出释放
  agent/logs/error.log
  storage/<generationId>/
    ready.json
    state.sqlite                # 运行时可能同时存在 -wal、-shm
    credentials.enc
    agent/sessions/...
    agent/attachments/...       # 内容文件与专用 index.json
    agents/*.md                 # 个人智能体配置正文
```

`active-generation.json` 与 `ready.json` 使用 format 2、schemaVersion 1、transcriptVersion 2。这里的 schemaVersion 是 generation 格式的初始基线；数据库当前版本由 `PRAGMA user_version` 和 `schema_migrations` 共同记录，升级数据库不重写 generation 指针。运行入口先取得根目录锁；没有指针时仅在未检测到旧数据的根创建新 generation。发现旧 settings/projects/groups 或旧 sessions 时拒绝启动，交由离线工具。缺失或无效的已发布 generation 不会从旧 JSON 猜建。

- `StateStore` 使用 Node 24 的 `node:sqlite`；启用 foreign_keys、WAL、busy_timeout=5000、synchronous=FULL。schema 账本是新数据库版本管理，不是旧数据兼容器。
- `projects`、`tasks`、`task_groups`、`app_settings`、`drafts`、`queue_state`、`queue_items`、`accepted_inputs`、`task_runtime` 是业务状态；`storage_operations` 是跨文件恢复意图。任务的一些低频字段保存在经过应用验证的 JSON 列中，不是计划中每一项都有单独 SQL 列。
- `SettingsStore` 从 `app_settings` 的 `app` 键读取公共配置，提供商定义也在该配置中；当前没有独立 providers 表。API key/OAuth 凭据继续使用加密文件，不写入公共设置。系统加密不可用时凭据只在内存保留。
- 智能体启用/选择状态保存在 `app_settings` 的 `subagentProfiles` 键；个人配置正文仍是 generation 内的 `agents/*.md`，项目配置仍是项目中的 `.zpi/agents/*.md`。运行时不读取旧 `agents-state.json`。
- 草稿文本、选择范围、文件引用、revision 存在 `drafts`。旧 revision 写入被忽略；非法新格式记录报错，不清空后重建。输入草稿与任务 draft 标记及待发送队列分别保存。
- 分组与成员/根级顺序通过 `StateStore.setTaskGroups` 的事务保存；删除组保留任务。展开状态仍由 renderer 保存。
- `operation_log` 随状态事务记录成功/失败，不用于重建业务状态，也不包含完整提示词/工具输出。保留清理不能代替业务备份。
- `HistoryIndex` 在同一个数据库维护 `transcript_*` 派生表，包括偏移、run/call、checkpoint、journal 与搜索投影。只能重建这些派生数据，禁止把整个 `state.sqlite` 当旧缓存删除。
- 会话文件使用 v2 header 与递增 seq；允许消息、压缩及 run/call/tool_journal/context_anchor 等明确事实类型。标题、置顶、选择、队列等产品快照不属于日志。运行时适配层使用内部 SessionEntry 类型不意味着允许旧 JSONL 直接打开。
- 附件继续采用受控内容文件和附件索引，不在本次强行迁 SQLite。fork 复制合并多个批次，保留目标已有附件；缓存文件通过文件复制保留，父任务删除后子任务自己的副本仍可读取。外部项目文件仍是外部引用，不会因为 fork 自动备份整个工作目录。

### SQLite 顺序升级与任务校验

已发布的 SQLite v1 可直接升级到当前 v3：v1 定义冻结在 `state-schema-v1.ts`；v2 为账本增加迁移 SQL 的 SHA-256 与各版本结构摘要，并创建 transcript 的未结束调用部分索引 `(path) WHERE complete=0` 和起点索引 `(path,start)`；v3 增加持久化清理待办，并为已有删除墓碑补建待办。所有待执行版本按顺序在一个事务内提交，任何一步失败均回滚结构、账本、数据与 `user_version`。重复启动不重复迁移，也不改写已有应用时间。

打开已有库先只读校验版本、已知表/索引定义和完整账本；未知更新版本、意外对象、被修改的定义或校验值均拒绝打开，不删除数据库重建。缺失的 transcript 派生表可按既定定义重建，同时使其缓存水位失效；存在但定义异常的派生表也拒绝打开。启动不扫描所有历史页，完整 integrity/foreign-key 检查仍由显式诊断触发。

任务 SQL 主键 `id` 是唯一身份；结构化列负责项目/父任务/分组、顺序、标题、创建/更新时间和 revision。JSON 负责其余持久化字段，历史 JSON 中上述结构化字段的副本可能过时，读取时使用 SQL 值；JSON 的 ID 必须与主键一致。读取和写入均校验必需字段、可选字段与嵌套字段的类型，缺字段、错误类型或身份冲突会给出包含任务 ID 和字段名的 `storage:` 诊断。启动在恢复任务运行状态前校验全部活动任务；损坏记录会阻止恢复并通过现有启动错误提示/日志报告，不跳过记录、不构造替代任务、不改写原数据。缺失会话路径进入已有任务历史诊断流程。

任务 revision 表示持久化任务字段的版本，包括分组归属、根/组内排序、项目解绑、归档与删除；不包含独立的草稿、队列、运行时表或分组标题。一次操作按最终任务值比较，有变化递增一次，无变化保持原值。删除墓碑不能通过普通 upsert 复活。

### 删除与旧代际回收

归档只改变任务状态，保留会话、索引、搜索和附件。删除在提交墓碑时原子写入 `storage_cleanup`，随后回收所有对应 `transcript_*` 行、搜索文本、JSONL 代际与任务专属附件/输出。即使文件已不存在，仍清理对应索引。失败待办保留 `attempts` / `last_error`，错误日志使用 `session.delete.cleanup`，下次启动在恢复意图处理后自动重试；文件已删但 SQL 清理失败也可重试。

成功发布新 JSONL 代际时，旧路径与新定位的提交在同一事务中进入待办，留到下次启动回收，避免影响本次进程中的历史读取。当前任务（含归档任务）的路径、未完成恢复意图的目标/结果路径，以及该意图所属任务的旧代际都受保护。删除任务时取消其自己的恢复意图，但其他任务的引用仍受保护。升级前的旧代际仅在显式删除所属任务时，依据受管目录内的任务文件名、文件头 ID 和索引定位回收；不对无法证明归属的孤立文件做全盘清扫。错误身份、异常文件或越出受管目录的路径保留并报告，等待明确修复后重试。显式删除任务时，其墓碑中登记的受管 JSONL 文件即使文件头损坏也可删除；其他代际必须验证文件头，合法但 ID 不符的文件始终保留。

主要实现：[StateStore](../../packages/desktop/src/main/state-store.ts)、[存储入口](../../packages/desktop/src/main/storage-generation.ts)、[设置](../../packages/desktop/src/main/storage.ts)、[JSONL 合同](../../packages/desktop/src/main/transcript-v2.ts)、[索引](../../packages/desktop/src/main/history-index.ts)。

## 隔离试用与人工验收

普通 `npm run dev` 与已安装 Preview 共用默认数据目录。首次试用本分支不得直接指向唯一生产数据。`ZPI_DATA_DIR` 可指定绝对路径覆盖数据根，不启用测试模式；相对路径会被拒绝。测试模式下 `ZPI_TEST_DATA_DIR` 优先。

已发布 SQLite v1 和当前顺序迁移版本受支持。首次发布前的异常开发中间结构不自动推测转换。人工验收请使用新建隔离目录、旧 SQLite 副本，或从受支持的旧 JSON 数据副本运行离线迁移。

在独立临时目录进行真实分支试用（POSIX shell）：

```sh
TRIAL_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/zpi-sqlite-trial.XXXXXX")"
ZPI_DATA_DIR="$TRIAL_ROOT" npm run dev
```

此方式仅隔离数据根，不隔离操作系统权限、项目文件、网络请求或钥匙串身份，也不会清除环境中的 API Key。使用专门的测试项目和模型配置；无需导入真实提供商时先在启动环境移除对应变量。不要删除运行中的目录或用生产目录替换 `TRIAL_ROOT`。

需要模拟系统交互时可另用：

```sh
ZPI_TEST_MODE=1 ZPI_TEST_SHOW_WINDOW=1 ZPI_TEST_DATA_DIR="$TRIAL_ROOT" npm run dev
```

测试模式不保存真实加密凭据、不自动导入环境提供商、不注册真实全局快捷键，部分系统交互被模拟。该模式通过不能替代真实钥匙串、系统权限、全局快捷键或发行包验收。

分支人工验收建议：

1. 记录提交/工作树状态、Node 与 Electron 版本、系统和 CPU。新目录启动后确认指针、ready 和数据库存在，没有新建旧 settings/projects/groups 文件。
2. 创建项目和任务，改名、置顶、归档、移动组、改组名/颜色/顺序；调整字体、快捷键和默认模型；保存草稿选择范围。正常退出再打开同一目录，逐项确认。
3. 使用假模型发送、继续、停止，排队并暂停输入，压缩后继续；核对实际请求保留的消息、图片和签名，不能只看 UI 文本。
4. 创建辅助对话/fork、编辑最新轮；跨多个附件批次复制后删除父任务，确认子任务图片和缓存文件仍可用。外部文件引用单独验证。
5. 运行后台命令/子智能体后异常退出，先确认所有旧进程已结束，再检查遗留锁。重开应呈现中断/失联和保留输入，不能自动重跑工具或凭旧 PID 认领进程。异常锁不会按超时自动清除；确认 owner 与进程终止后才人工清理专用锁目录。
6. 仅在可丢弃副本进行数据库失败、半行日志、索引失效、文件换代故障测试；保留原文件与错误证据。绝不能通过删权威库让启动“恢复正常”。
7. 在目标发行平台分别验证 Electron 41.10.7 的 `node:sqlite`、WAL、重开和打包路径。真实系统加密/快捷键用专用 OS 测试账户或完整独立测试身份验收，不以测试模式的 mock 代替。

按需读取已有 [100 MiB/1 GiB 合成样本测量报告](../storage-lazy-restore-benchmark.md)，包括环境、读字节、parse 数、内存端点及明确未测项。单次暖缓存样本不等于完整预算验收，Node 单测也不等于目标 Electron GUI、发行包或掉电恢复验收。无压缩且全部历史都是有效上下文时，首次模型请求仍需要完整有效历史。

## 独立迁移 CLI

工具入口是 `scripts/storage-migrate.ts`，目前没有 npm `storage-migrate` script。使用仓库安装的 tsx（以下命令不迁移真实数据，路径需操作者自行指定）：

```sh
SOURCE="/absolute/path/to/offline-legacy-copy"
TARGET="/absolute/path/to/new-trial-root"
PLAN="/absolute/path/outside-source/migration-plan.json"
npx tsx scripts/storage-migrate.ts inspect --source "$SOURCE"
npx tsx scripts/storage-migrate.ts plan --source "$SOURCE" --plan "$PLAN"
npx tsx scripts/storage-migrate.ts convert --plan "$PLAN" --target "$TARGET" --offline-confirmed
# 使用 convert 实际输出的 staging 目录：
npx tsx scripts/storage-migrate.ts validate --generation "/actual/target/storage/migration-id.staging"
npx tsx scripts/storage-migrate.ts activate --plan "$PLAN" --target "$TARGET" --offline-confirmed
```

执行前退出所有旧/新客户端和后台写入者，保存完整离线备份。`--offline-confirmed` 是操作者对停机的确认，不会自动停止旧进程；旧程序也不会遵守新工具的维护锁。源与目标必须不相交，计划文件必须在源目录外。不要把 plan 写入源目录，否则指纹变化会使其失效。

`inspect/plan` 只读扫描明确的旧存储根，记录文件指纹、会话、blockers 和 `omittedRootEntries`；被忽略的根条目需操作者审阅，阻塞计划不得转换。`convert` 复核源指纹，在目标生成独立 `.staging`，保存 plan、manifest、SQLite、转换日志与必要受控文件。已有 staging 不会盲目续写，应保留诊断后重新生成计划。

旧 JSONL 按 64 KiB chunk 读取，每条记录上限 8 MiB；记录、ID 与 journal 工作集存入可丢弃的临时 SQLite spool，转换按条迭代，不构造整份历史数组。spool 以磁盘空间换取受控正文工作集，并非零额外磁盘需求或整段迁移严格常量内存的承诺（文件清单、任务列表和单条载荷仍有成本）。它关闭同步保障仅因为是临时派生数据，不改变目标权威数据库的 FULL/WAL 配置。

适配器接受当前 main 分支写出的记录形态：`zpi.title` 允许 `provider`/`modelId` 字段（标题生成任务写入，迁移时仅 `state` 进入任务标题状态）；侧聊继承产生的无 `data` 载荷 `zpi.context_boundary` 锚点按原 ID 保留并补成空对象载荷，因为 v2 事实记录要求对象载荷。

`validate` 校验目标文件哈希、manifest/plan 一致性、仍可访问的旧源指纹、任务数量/归属/字段、草稿、队列、公共设置与智能体状态；重新按相同固定适配器转换旧源，并逐条比较 JSONL v2 内容与条数，最后检查数据库 integrity/foreign keys。因此 validate 和 activate 都要求原离线源仍存在且未变化。这里的逐条语义对照使用同一个迁移适配器，并不是独立旧/新算法的全 cutoff 模型请求等价证明，也不替代实际应用验收。

`activate` 再校验、发布 ready、重命名 staging 并原子切换目标活动指针，不覆盖旧源。

迁移仅在此工具的旧格式解析器中发生，应用正常启动不调用它。工具不会解密凭据；复制的认证数据可能需要重新授权。必须核对设置、任务组织、草稿/队列、附件、上下文和模型实际请求，再允许切换真实数据。

当前实现的受控文件路径重定位使用目标 final 目录的绝对路径，派生索引也以路径定位；不能把生成目录任意搬走后宣称仍可用。目标目录应从计划/转换到试用保持不变。validate/activate 必须拒绝实际 final 目录与 manifest relocation.destination 不一致的产物。受控路径按真实文件归属匹配清单，允许旧源的符号链接别名，但不得将外部项目文件误判为迁移资产；源内缺失或不支持的引用必须阻塞。从路径不同的离线副本迁移时，记录内指向原数据根 `agent/(attachments|tool-output|file-changes|session-context)` 的绝对引用不在源内、保持不变，若目标就是原数据根，需保留原根下这些受管目录旧引用才可读。迁移的异步目录同步遵循运行时相同的平台策略：Windows 跳过目录 fsync，其他平台传播同步失败。旧 `agents-state.json` 转入 `app_settings.subagentProfiles`，个人 `agents/*.md` 保留为文件。工具复制旧 `agent/` 下非 sessions 的受控内容及认证文件；外部 profile/skills 和项目工作目录不属于数据库资产，按计划中的清单及 `omittedRootEntries` 单独核对。

## 备份、失败与回滚限制

- 最简单可靠的备份方式是正常退出所有写入者后复制完整应用数据根和其关联受控文件。运行中单独复制 `.sqlite` 会漏掉 WAL 或产生不一致文件组合；没有经过验证的在线备份命令时不要这样做。
- 旧源始终保留。回到旧版本只能打开旧源/旧备份；新版本试用产生的新会话与改动不会自动反向转换。不能拿旧可执行文件打开新 generation，也不能仅删除活动指针来“降级”。
- 已激活 generation 被运行时写入后，迁移 manifest 是转换时快照，不是当前数据库的持续校验清单；之后再次 validate 可能因正常修改而失败。
- 凭据文件与数据库并非单个原子提交单元。设置写入失败会尝试恢复原加密字节，但突然断电不能由这一异常回滚逻辑保证跨文件一致性；保持离线备份并检查认证状态。
- 目录 fsync 在 Windows 被显式跳过，因此不能从 Linux/macOS 的成功推出 Windows 有同等掉电保障。文件系统、硬件和目标平台的真实失败测试仍是发布门槛。

## 定向验证

```sh
npm run test:unit -- packages/desktop/test/storage.test.ts packages/desktop/test/shortcut-storage.test.ts packages/desktop/test/draft-store.test.ts packages/desktop/test/task-groups.test.ts packages/desktop/test/attachment-copy.test.ts packages/desktop/test/sqlite-preferences-reopen.test.ts
npm run test:unit -- packages/desktop/test/storage-generation.test.ts packages/desktop/test/state-store.test.ts packages/desktop/test/storage-migration.test.ts
npm run test:unit -- packages/desktop/test/state-migrations.test.ts packages/desktop/test/storage-cleanup.test.ts packages/desktop/test/history-query-plan.test.ts
npm run test:unit -- packages/desktop/test/side-chat-recovery.test.ts packages/desktop/test/edit-recovery.test.ts packages/desktop/test/storage-host-recovery.test.ts packages/desktop/test/sqlite-build.test.ts
npm run check
npm run build
```

需要完整集成、GUI 和发行包验收时继续遵循 [开发指南](../development.md#测试)，并分别记录通过、失败和未运行项。

### Electron 与构建边界

本轮已用实际 Electron 二进制的 `ELECTRON_RUN_AS_NODE=1` 模式完成 SQLite 能力烟测。它验证该二进制附带的 Node 能加载 SQLite，不是 GUI 主进程、应用生命周期或打包验收。`scripts/desktop-build.mjs` 对主进程和 preload 显式设置 `removeNodeProtocol: false`，保留 `node:sqlite` 的必要前缀；`sqlite-build.test.ts` 验证产物保留该前缀并能执行 SQLite 查询。

可选大数据验证（只生成并删除临时合成数据，不使用真实旧数据）：

```sh
node --import tsx scripts/benchmark-lazy-restore.ts 100,1024 1
node --import tsx scripts/benchmark-storage-migration.ts 100
node --import tsx scripts/benchmark-storage-migration.ts 1024
```

迁移脚本报告 inspect 与 convert（包含 validate）耗时、进程 lifetime maxRSS；不报告 30 次分位数、物理磁盘 I/O 或临时磁盘高水位。大数据测试需足够空间容纳源、staging 与临时 spool，不纳入默认单测。
