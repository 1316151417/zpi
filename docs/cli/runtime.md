# 会话执行与隔离

在拟建的 `packages/cli/` 中放置 bin、参数解析、TUI、打印器、资源适配及测试。交互和打印共用同一个执行函数。模型来源仅负责提供模型调用，终端所在进程持有会话、执行工具并写 CLI 历史。

## 一条原生执行路径

1. 解析调用方式，取 `realpath(cwd)`。帮助、模型和账户管理等本地操作在创建会话前完成。按[模型配置与账户](models.md)解析服务、账户和模型，按[公共资源](resources.md)加载指令及显式引用。
2. 新交互会话在第一次有效提交时创建持久 `SessionManager`。续聊先验证 ID 和目录归属，取得该会话的跨进程写锁，复核后再打开文件。普通 `-p` 使用 `SessionManager.inMemory(cwd)`，并为本次创建私有临时 `agentDir`。
3. 两种模式均调用 `createAgentSession({ cwd, agentDir, sessionManager, settingsManager, modelRuntime, resourceLoader })`。复用原生 read、edit、write、bash、上下文压缩、模型重试及取消语义。模型目录由现有 `ModelRuntime` 注册。不要另写调度循环或同时维护 SDK 和原生两条运行路径。[创建会话](../../packages/coding-agent/src/core/sdk.ts) · [模型运行时](../../packages/coding-agent/src/core/model-runtime.ts)
4. 订阅 `session.subscribe`，用同一个 `InputContext` 调用 `prepareInput` 和 `runSessionInput`。后者负责执行、flush 和错误分类。TUI 显示文本、工具和重试事件，打印器取本轮最终可见助手文本或本轮 `command_result.message`。控制命令或失败不能误输出上一轮回答。[输入与事件](../../packages/coding-agent/src/core/agent-session.ts) · [原生执行入口](../../packages/coding-agent/src/core/host-run.ts)
5. 收到中断时取消本轮，等待实际结束。关闭进程前 flush、退订、dispose、清理临时目录、释放写锁并恢复 TTY。退出时未提交的草稿直接丢弃。重启后由用户决定是否再次提交，避免自动重做已有工具副作用。

## 只保存续聊需要的数据

| 数据 | 归属与行为 |
| --- | --- |
| 持久会话 | 以实际目录路径的 SHA-256 作为目录名，原始 cwd 写在原生文件头。历史在 `~/.zpi/cli/<目录哈希>/sessions/<id>.jsonl`，工具需要的快照在同一 CLI 目录的 `tool-output/<id>/`。按目录分开即可，无需项目表、全局索引或跨端同步。 |
| 展开过的输入 | 当 Skill、命令或引用改变了送给模型的正文，通过原生自定义记录关联 inputId 和用户原始输入。恢复会话时使用简短原文显示，模型历史仍含执行所需的完整内容。早期记录按已有消息回放。 |
| 最近会话与历史列表 | 只枚举当前目录的历史，按文件最近活动时间排序，优先显示原生会话名称，未命名时用第一条用户消息作摘要。预览用原生只读解析，过滤没有有效用户消息的记录。损坏文件单独报告，其余会话可继续选择。 |
| 同时续写 | 每个会话只允许一个进程写。在 CLI 自有的 `locks/<id>.sqlite` 上由专用连接持有 `BEGIN IMMEDIATE`，零等待，占用即返回。此文件只负责互斥，进程退出由系统释放。列表和预览不获取写锁，不调用可能修复尾行的 `SessionManager.open`。[原生会话文件](../../packages/coding-agent/src/core/session-manager.ts) · [只读解析](../../packages/coding-agent/src/core/record-validation.ts) |
| 临时调用 | 普通 `-p` 的历史、工具快照均限于内存或当次临时目录，正常结束、失败和可捕获的中断均清理。已经按用户要求改写的工作区文件保留。显式 `-c/-r` 续写则与交互模式同样加锁、落盘。 |
| 模型与账户绑定 | 内核保存模型选择。CLI 另用已有 `appendCustomEntryAsync` 将非敏感的服务、模型及稳定账户 ID 关联到本次选模，在第一次模型请求前持锁写入并 flush。恢复时复核完整绑定。若绑定缺失或不一致，提示用户用 `-m` 明确选择，不猜测账户。 |
| Desktop 状态 | 项目、会话、任务、记忆、附件、草稿、工作树与归档归各自宿主管理。CLI 不读写桌面状态库、不拿桌面存储锁。目录中的实际项目文件仍然是用户在两个客户端看到的同一份文件。 |

原生 `SessionManager.create` 会立即写文件头。开始新会话前先完成参数和可用模型校验，选择历史时须有真实用户输入。即使在首次写入中途退出，也不会给用户留下一条只有文件头的对话。遇到写锁冲突只报告目标会话被占用，不跳到旧会话或创建另一条。
