# 业务存储、凭据、generation 与清理

使用入口：[备份与恢复](../features/storage.md)。对话事实的写入链见[历史与 Worker](history.md)。

## 两类数据，两个权威来源

业务 SQLite 保存任务标题、目录、项目/分组、置顶、归档、模型选择、草稿、队列、设置和运行意图。JSONL 保存对话事实。不能通过修改 UI 投影反写一份替代 transcript，也不能从旧 transcript 覆盖更新过的任务字段。

TaskState 的 SQL 归属/顺序列是权威，附加 JSON 必须验证。revision 针对持久任务字段变化，不随每个流 delta、草稿或队列更新而增长。删除通过 tombstone 阻止迟到 upsert 复活。

## 数据库打开与迁移

使用 Node 24 的 `node:sqlite` DatabaseSync，启用 WAL、FULL 同步、foreign keys 和 5000 ms busy timeout。schema 迁移通过 user_version 与 schema_migrations 共同验证；v1 保持基线，v2 加迁移账本与索引，v3 加待清理记录。

打开前做只读结构验证，检查表/索引等对象摘要。未知或被修改的结构不能静默重建为空库。事务内更新有关联的业务状态，凭据则不允许出现在任意普通 JSON 字段中。

## generation 发布

`active-generation.json` 指向 `storage/<generationId>`，目标必须有匹配的 ready.json 与有效 state.sqlite。marker 的 format=2、schemaVersion=1、transcriptVersion=2 与业务数据库 schema 版本是不同概念，不能混写。

生成新数据先在独立目录准备和验证，再持久化指针；旧 generation 保留到可安全清理。JSON 使用独占临时文件、fsync、rename；目录同步在平台支持时执行，Windows 不通过 Node 目录 fsync 模拟同等保证。

## 单写者锁

`.storage-lock.sqlite` 的 `BEGIN IMMEDIATE` 提供进程锁，进程退出后由操作系统释放。兼容 `.storage-lock/owner.json` 保存 token、PID、用途。

遗留目录存在时只在 PID 探测明确得到 ESRCH 后回收。进程仍活、EPERM、owner 缺失/坏格式都不是“已退出”的证据，会拒绝打开并提示检查。因此不应照旧文档遇到锁就手动删除；当前实现能自动恢复一部分已确认死亡的 owner。

## 凭据

API key 和 OAuth token 放在独立加密凭据存储，不进入 StateStore、transcript 或 UI 快照。系统加密不可用时会话内存可持有凭据，但不能把明文假装成已安全持久化。业务设置与凭据文件并非跨文件原子事务，恢复需要承认断电边界。

OAuth 刷新先持久化轮换结果，再完成可能失败的身份验证，防止旧 refresh token 已失效却丢掉新 token。并发和断开竞争见[登录与刷新](openai-auth.md)。

## 删除和后台清理

业务 tombstone 与 cleanup pending 在事务中记录；文件删除可失败并在下次启动重试。清理校验 generation、任务标识和路径，不碰当前有效数据、归档关联或尚在进行的操作。显式删除且归属已确认的损坏日志可以清理；身份不匹配的文件保留诊断。

切换 generation 后旧目录的清理按安全时机排队。清空记忆有额外 writer 和水位协调，见[记忆](memory.md)。

## 离线迁移

迁移脚本分 inspect、plan、convert、validate、activate 阶段，持有同一存储锁。转换使用分块读取和 SQLite spool，避免全部历史进内存；激活前比较来源是否变化。manifest 记录绝对目标路径，转换后不可随意移动目录再激活。

验证比较存在共用适配器的限制，不等于两个完全独立实现的数学证明。运行时不长期同时兼容所有旧格式；旧格式转换留在离线脚本中。

源码：[StateStore](../../packages/desktop/src/main/state-store.ts)、[迁移](../../packages/desktop/src/main/state-migrations.ts)、[generation](../../packages/desktop/src/main/storage-generation.ts)、[清理](../../packages/desktop/src/main/storage-cleanup.ts)、[设置/凭据](../../packages/desktop/src/main/storage.ts)、[离线流程](../../scripts/storage-migration/workflow.ts)。回归：[generation](../../packages/desktop/test/storage-generation.test.ts)、[schema](../../packages/desktop/test/state-migrations.test.ts)、[清理](../../packages/desktop/test/storage-cleanup.test.ts)、[迁移](../../packages/desktop/test/storage-migration.test.ts)。
