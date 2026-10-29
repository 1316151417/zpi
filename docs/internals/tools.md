# read、write、edit、bash 的实现

使用入口：[基础工具](../features/tools.md)。核心只有四个内置工具；桌面能力通过 SDK 扩展接入。

## 路径与权限

相对路径基于当前 cwd 解析，绝对路径按绝对路径处理。cwd 是默认位置，不是文件系统沙箱。工具通过宿主进程权限访问文件和执行命令；Git worktree 也不隔离权限。

工具 definition 包含 schema、参数预处理、execute 和提示片段，wrapper 注入动态 ToolContext。传入自定义 operations 可替换本地 I/O；这种替换不自动获得本地文件变更观察能力。

## read：有界结果与完整扫描

文本默认最多返回 2000 行、50 KiB，支持从 1 开始的 offset 和正整数 limit。流式范围读取只保留所需正文，但为准确计算总行数、内容 hash 和截断提示仍可能扫描完整文件；分页返回不等于只读取磁盘上那几行。

`FileReadState` 保存路径、完整内容 hash 和已经完整呈现过的范围。相同内容与范围可以返回未变化提示；截断结果不标记为完整可复用，后续仍能读取。该状态只属于当前模型上下文，不是持久化文件缓存。

图片走类型检测、尺寸/像素预算和缩放管线，读取源图限制为 20 MiB。特殊文件使用普通文件检查和有界 I/O，避免对 FIFO 等无限等待。请求级媒体预算另见[上下文](context.md)。

## write：整文件替换

write 自动创建父目录，写入完整 UTF-8 内容。它会覆盖现有文件；模型应使用 edit 做局部修改。成功写入更新已读状态，因为整个新内容已由模型提供。

同一真实文件的变更在 mutation queue 内串行，路径别名也要归并。取消在写前检查；已经进入的写操作必须等实际结束才释放队列。写成功后不能只因 signal 刚刚取消就报告“没有改动”。

## edit：基于原文匹配

一次调用接受多个 `edits: [{ oldText, newText }]`。所有 oldText 都匹配同一份原文件，不是在上一项替换结果上继续查找；匹配必须唯一且区域不重叠。相邻修改应合并成一个块。

预处理兼容部分模型返回的 JSON 字符串、单个 edit 对象及旧 oldText/newText 字段。匹配先处理 BOM 和换行，再由 edit-diff 的规范化/模糊匹配规则处理有限的文本差异；歧义不能猜测。

准备完新内容后重新读取磁盘，若内容变化则拒绝覆盖。这只防范准备期间观察到的外部修改，不是操作系统级原子文件锁。编辑会使旧范围失效，只有此前完整文件已知时才把新全文继续标为已知。

模型展示用 diff 和 patch 各有 64 KiB 上限，过大时说明省略。回退需要的 before/after 文件快照独立记录，不受这份行内预览上限控制。

## bash：执行和输出

SDK bash 启动 shell 子进程，可选 timeout 单位为秒，必须为合法正数；默认没有超时。输出累加器保留有界预览，模型通常拿尾部最多 2000 行、50 KiB；完整输出可以落到临时文件。结构化输出还有独立的 1 MiB 边界。

进度约每 100 毫秒合并，定制 onData 可返回 Promise 施加背压。取消要终止对应进程树并完成输出收尾，不能用无范围的全局进程清理。

桌面会覆盖 bash，提供后台执行与 TaskOutput/TaskStop；SDK 的 bash 不包含这套调度，见[后台进程](background-terminal.md)。

## 源码与回归入口

- [工具装配](../../packages/coding-agent/src/core/tools/index.ts)、[read](../../packages/coding-agent/src/core/tools/pi/read.ts)、[edit](../../packages/coding-agent/src/core/tools/pi/edit.ts)、[write](../../packages/coding-agent/src/core/tools/pi/write.ts)、[bash](../../packages/coding-agent/src/core/tools/pi/bash.ts)。
- [文件读状态](../../packages/coding-agent/src/core/tools/pi/file-read-state.ts)、[变更队列](../../packages/coding-agent/src/core/tools/pi/file-mutation-queue.ts)、[输出累加器](../../packages/coding-agent/src/core/tools/pi/output-accumulator.ts)。
- [别名并发测试](../../packages/coding-agent/test/mutation-alias.test.ts)、[特殊文件测试](../../packages/coding-agent/test/read-special-files.test.ts)、[背压测试](../../packages/coding-agent/test/bash-output-backpressure.test.ts)、[大编辑持久化](../../packages/desktop/test/large-edit-durability.test.ts)。
