# 记忆的读取、提取、整合与恢复

使用入口：[记忆](../features/memory.md)。记忆是跨会话材料；[上下文压缩](context.md)只缩短当前会话输入。

## 模式与作用域

记忆策略由系统内置 memory 插件提供，模式为 `off`、`short` 或 `long`，默认 `short`。新会话首次发送时将模式冻结到插件选项。记忆页与插件页共享 `plugins.options["zpi.memory"].mode`，模型和周期存于记忆服务设置；禁用插件时有效模式为 `off`，保留的选项用于再次启用。已有任务使用自己的插件快照，不能因为全局开关变化突然获得另一套系统材料。运行时只读取当前设置与状态格式，不转换旧字段或旧布局。

MemoryPolicy 在首次资源捕获时选择并保存注入内容，UserPromptSubmit 复用会话快照并调度检查，在 PostToolUse 记录成功读取的来源，在 RunEnd 释放根任务选择；它持有批次、模型快照、上下文选择和使用状态。宿主提供模型解析、历史读取和持久化端口；插件的 `memory/sources.ts` 适配器负责来源筛选、稳定证据快照和清空边界，MemoryPolicy 从持久快照恢复已继承的注入内容。长期生成、恢复与清空复用插件包中的 LongMemoryService；两者均由 BuiltinPluginRuntime 管理生命周期。

## 短期文件

用户和项目短期文件分别解析，每份最多 20 条，每条最多 2000 个 Unicode code points，文件最多 64 KiB。ID 为 1–64 字符的有限 ASCII 名称；UTF-8、条目格式和缩进有严格校验，坏文件整份跳过并诊断，不混入半份内容。

读取通过 realpath/inode 去重，避免同一文件以不同路径重复注入。续行使用约定缩进。内容在会话首次发送时固定，后续输入和冷恢复不重读；外部修改对新建独立会话生效。它不需要模型后台提取。

## 长期工作区

长期 v2 位于当前数据 generation 的 `memories_v2`，包含主摘要、rollout_summaries、`extensions/ad_hoc/notes`、阶段指令及受控工作区。主摘要小于 10000 UTF-8 字节，首行必须为 `v1`，必须含 `## User Profile`、`## User preferences`、`## General Tips`、`## What's in Memory` 四个标题。

只有主摘要自动加入普通模型上下文，明细由模型按需读取。会话提取结果使用稳定哈希文件名，单份摘要最多 9000 UTF-8 字节；明确要求记忆的事项可以进入 ad_hoc 笔记。读取笔记有 512000 字节上限，禁止符号链接和凭据文件。没有旧式 MEMORY/raw/skills 自动目录。

## 第一阶段：提取

由合格根任务的运行时检查或手动动作触发，不是独立定时器。候选默认只考虑最近 10 天、空闲至少 6 小时的记录，每批最多两个，候选扫描有上限。子任务、辅助对话、归档和诊断材料不作为普通提取源。

证据过滤去掉系统提示、记忆注入和通知等派生内容，避免让模型反复“记住自己的记忆”。按有效上下文的 70% 控制提取输入预算，无法获得窗口信息时使用保守回退预算。

模型返回 `rollout_summary` 和 `rollout_slug`；支持时使用结构化输出，并始终做本地验证。相同边界失败有退避和次数限制：默认退避一小时，三次失败后不继续冲击同一边界；取消不记作失败。提取 checkpoint 和来源边界用于判断哪些新事实尚未处理。

## 第二阶段：整合

整合最多使用 256 个来源，默认排除超过 30 天未使用的来源，并限制总计 300000 字符。先同步输入、识别过期源和 Git 差异；无变化则跳过。临时 SDK 会话仅能对受控文件执行 read/write/edit，写入范围限主摘要，不提供 bash、网络、子智能体或外部技能。

默认总预算 64 次请求、15 分钟批次时间、每请求 5 分钟。输入清单、路径和内容需保持不变；输出经过格式、容量与引用来源检查后才能发布。失败时恢复原摘要，不推进成功边界。前端只看到已确认摘要，不展示模型尚在改写的中间状态。

SQLite 保存成功状态，Git 使用单提交基线比较整合工作区，不把长期记忆变成无限增长的开发分支。临时 `phase2_workspace_diff` 服务于本轮恢复和变更检查。

## 清空、恢复与并发

清空长期记忆先停止 writer，再删除当前长期记忆工作区并更新清空水位；保留会话历史和短期文件。重写 generation 后也重建边界，防止旧任务扫描把清掉的记忆立即恢复。

恢复先停止写入者，再恢复之前的有效摘要和不可变输入；不能一边整合一边替换目录。持久状态只接受当前 version 2，不在启动或恢复时处理历史格式。

已有会话及子智能体保留自己已捕获的注入文本，清空和新整合结果只影响后续新建对话。详细来源文件仍属于显式按需读取的材料。

## 源码与回归入口

- [短期](../../packages/builtin-plugins/src/memory/short-memory.ts)、[长期](../../packages/builtin-plugins/src/memory/long-memory.ts)、[runner](../../packages/builtin-plugins/src/memory/runner.ts)、[工作区](../../packages/builtin-plugins/src/memory/workspace.ts)、[证据](../../packages/builtin-plugins/src/memory/evidence.ts)。
- [提取提示](../../packages/builtin-plugins/src/memory/extraction-instructions.ts)、[整合提示](../../packages/builtin-plugins/src/memory/consolidation-instructions.ts)、[临时笔记规则](../../packages/builtin-plugins/src/memory/ad-hoc-instructions.ts)。
- [长期测试](../../packages/builtin-plugins/test/long-memory.test.ts)、[runner 测试](../../packages/builtin-plugins/test/memory-runner.test.ts)、[恢复工作区](../../packages/builtin-plugins/test/memory-workspace.test.ts)、[生命周期](../../packages/desktop/test/memory-host-lifecycle.test.ts)、[笔记](../../packages/builtin-plugins/test/memory-notes.test.ts)。
