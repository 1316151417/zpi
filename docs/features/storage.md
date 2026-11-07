# 本地数据、备份和恢复

ZPI 使用 SQLite 保存业务状态，JSONL v2 保存会话事实，另有派生历史索引和受控附件。数据根与项目目录是不同位置。

## 数据位置

macOS 正式版默认 `~/Library/Application Support/ZPI/`，开发版和 Preview 默认 `~/Library/Application Support/ZPI Preview/`。其他系统使用 Electron 的对应用户数据目录。

`active-generation.json` 指向 `storage/<generationId>/`，其中包括 `state.sqlite`、`history.sqlite`、`credentials.enc`、会话及附件。完整布局见[存储原理](../internals/storage.md)。

绝对路径环境变量 `ZPI_DATA_DIR` 可以覆盖数据根。它只隔离应用数据，不隔离项目文件、权限、网络或钥匙串身份。开发版与 Preview 默认共用目录，应轮流运行。

## 备份

正常退出全部写入者，再复制完整数据根和关联受控文件。运行中只复制一个 `.sqlite` 可能漏掉 WAL 或获得不一致组合。项目工作目录、外部技能和用户资源需按用途另外备份。

`history.sqlite` 是派生索引，`state.sqlite` 和 JSONL 是权威数据，不能通过删除业务库“修复启动”。凭据复制到其他身份或机器后可能无法解密，届时需要重新登录。

## 当前格式

应用只接受当前 SQLite schema 4、应用设置 version 5、加密凭据 version 4 和 JSONL v2。新目录直接创建当前结构；已有数据必须已经符合当前格式。运行时没有旧配置转换、逐版本 schema 升级或旧目录读取分支，仓库也不携带一次性迁移工具。

## 锁与损坏

SQLite 事务锁保证同一数据根只有一个写入者，进程退出后由操作系统释放。遇到锁冲突应关闭占用同一目录的进程。

损坏记录、不同版本或被修改的 schema 会明确报错并保留原数据。当前格式的事务恢复、日志索引重建和失败清理重试仍正常工作。

启动时不会扫描或导入数据根中的旧 JSON 文件。备份与恢复应针对完整的当前数据根操作。机制见[存储原理](../internals/storage.md)。
