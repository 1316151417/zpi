# 自定义命令的存储、导入与执行

使用入口及模板示例：[自定义命令](../features/commands.md)。

## 存储和扫描

用户命令在 `~/.zpi/commands`，项目命令在 `.zpi/commands`。命令正文是 Markdown，启用状态独立保存。项目同名项覆盖用户项；禁用项目赢家不会重新启用用户同名项。

默认扫描限制为单文件 256 KiB、最多 1000 个命令、10000 个目录项、深度 8、累计 16 MiB。扫描解析 metadata，不执行正文。名称可包含目录层级，调用时冒号规范化为斜杠、名称转小写。init、compact、side、btw 保留给内置行为。

frontmatter 是专门的有限解析器，不是通用 YAML 求值器。description 和 argument-hint 可编辑；skills 支持标量、逗号或方括号列表，不接受块状列表，最多 64 个去重名称。未知元数据可保留，但 model/allowed-tools 当前不改变执行配置。

## 并发编辑与链接

更新带版本校验，磁盘已被外部修改就返回冲突，不能覆盖新内容。写入和删除验证命令根及路径边界。编辑导入软链接时需要明确源路径；删除本地链接不删除源文件。

导入只由显式 UI 操作触发，扫描支持的客户端配置后让用户选择项目、命令和复制/链接方式。目标碰撞不静默覆盖；受信任的链接来源由主进程 importer 记录，renderer 不能自己宣称一个任意链接属于已批准来源。

## 展开顺序

1. 解析 `/名称 参数`，执行前重读有效命令。
2. 先从原模板识别 inline `!` 反引号片段和 fenced `!` 块。
3. 在这些已确定的文字/命令片段中一次性替换 `$ARGUMENTS`、`$1` 等。
4. 按顺序运行原模板中的 Shell 片段，将 stdout 插入正文。
5. 加入技能与来源信息，形成模型输入；历史保留用户原始命令。

位置参数识别引号与反斜杠分组，不是完整 shell parser。缺失参数为空；没有占位符且用户传了参数时附加 User arguments。参数内出现新的 `$1` 或执行分隔符不会递归解释，但插入已有 shell 段的内容仍遵循 shell 语义。

## Shell 的失败边界

只在实际派发时执行，建议、预览、扫描、入队均不执行。每段复用基础 bash backend，超时 30 秒，stdout/stderr 累计上限 128 KiB；非零退出用最多 2000 字符错误详情终止展开。取消传播到进程树。

提供 ZPI/ZCode/Claude 兼容的 PROJECT_DIR、SESSION_ID 环境变量。缺少实际上下文的插件/技能变量会明确拒绝，不能替换为空后继续执行。模型请求重试复用已准备输入，不自动重跑具有副作用的 shell 模板。

源码：[store](../../packages/desktop/src/main/custom-commands.ts)、[展开](../../packages/desktop/src/main/custom-command-expansion.ts)、[shell](../../packages/desktop/src/main/custom-command-shell.ts)、[导入](../../packages/desktop/src/main/command-import.ts)。回归：[命令测试](../../packages/desktop/test/custom-commands.test.ts)、[导入测试](../../packages/desktop/test/command-import.test.ts)、[核心命令](../../packages/coding-agent/test/commands.test.ts)。
