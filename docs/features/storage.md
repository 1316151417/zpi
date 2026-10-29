# 本地数据、备份和迁移

ZPI 使用 SQLite 保存业务状态，JSONL v2 保存会话事实，另有派生历史索引和受控附件。数据根与项目目录是不同位置。

## 数据位置

macOS 正式版默认 `~/Library/Application Support/ZPI/`，开发版和 Preview 默认 `~/Library/Application Support/ZPI Preview/`。其他系统使用 Electron 的对应用户数据目录。

`active-generation.json` 指向 `storage/<generationId>/`，其中包括 `state.sqlite`、`history.sqlite`、`credentials.enc`、会话及附件。完整布局见[存储原理](../internals/storage.md)。

绝对路径环境变量 `ZPI_DATA_DIR` 可以覆盖数据根。它只隔离应用数据，不隔离项目文件、权限、网络或钥匙串身份。开发版与 Preview 默认共用目录，应轮流运行。

## 备份

正常退出全部写入者，再复制完整数据根和关联受控文件。运行中只复制一个 `.sqlite` 可能漏掉 WAL 或获得不一致组合。项目工作目录、外部技能和用户资源需按用途另外备份。

`history.sqlite` 是派生索引，`state.sqlite` 和 JSONL 是权威数据，不能通过删除业务库“修复启动”。凭据复制到其他身份或机器后可能无法解密，届时需要重新登录。

## 从旧 JSON 存储迁移

新运行时不会自动打开旧格式或后台迁移。先关闭旧、新客户端及迁移工具，保留离线源备份，在仓库依赖已安装的环境执行：

```sh
npx tsx scripts/storage-migrate.ts inspect --source /absolute/legacy
npx tsx scripts/storage-migrate.ts plan --source /absolute/legacy --plan /absolute/plans/zpi.json
npx tsx scripts/storage-migrate.ts convert --plan /absolute/plans/zpi.json --target /absolute/new-data --offline-confirmed
npx tsx scripts/storage-migrate.ts validate --generation /actual/output/migration.staging
npx tsx scripts/storage-migrate.ts activate --plan /absolute/plans/zpi.json --target /absolute/new-data --offline-confirmed
```

`validate` 的路径必须使用 convert 实际输出，不能照抄示例。源和目标不可相交，plan 放在源外；validate/activate 需要仍存在且未变化的离线源。`--offline-confirmed` 表示操作者已经停机，不会替你停止进程。

检查计划的 blockers 和忽略条目；转换失败保留诊断，重新生成计划。目标位置参与受控路径重定位，转换后不能随意搬走目录。

## 试用与回滚

```sh
ZPI_DATA_DIR=/absolute/new-data npm run dev
```

核对设置、任务组织、草稿、队列、附件和实际模型上下文。迁移 manifest 只描述转换时快照，正常使用后再次校验可能因合法修改失败。

回旧版本需要旧源或旧备份，新版本新增数据不会反向转换。不能让旧程序打开新 generation，也不能只删活动指针降级。

## 锁与损坏

进程退出会释放 SQLite 锁。兼容 owner 标记只有在确认旧进程不存在后自动清理；仍存活、无权检查或信息损坏时拒绝打开，不能按等待时长判定安全。

损坏的业务记录、未知新版本或被修改的 schema 会明确报错并保留原数据。任务删除的失败清理待办会在下次启动重试，不表示全部文件立即消失。

旧 `repair:sessions` 只修复未迁移的旧格式，不是 SQLite 修复工具，不应对活动 generation 运行。机制见[迁移与恢复](../internals/storage.md)。
