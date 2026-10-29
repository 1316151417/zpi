# 指令、技能与系统提示加载

使用入口：[上下文和技能](../features/context.md)。本仓库根 AGENTS.md 已按整理要求移除；应用支持读取用户项目中的 AGENTS.md，是另一件事。

## 固定发现顺序

`FileResourceLoader` 按以下顺序加载，后面的技能同名定义可以覆盖前面的：

1. `~/.agents/AGENTS.md` 与 `~/.agents/skills/`。
2. `~/.zpi/AGENTS.md` 与 `~/.zpi/skills/`。
3. `cwd/AGENTS.md` 与 `cwd/.agents/skills/`。
4. `cwd/.zpi/AGENTS.md` 与 `cwd/.zpi/skills/`。

这是固定根列表，不向上遍历所有父目录，也不递归搜项目里每一个 AGENTS.md。关闭项目资源会跳过后两组。指令和技能可并行读取，但最终顺序稳定，失败产生资源诊断。

## 技能发现和按需加载

技能根下只检查直接子目录或目录符号链接的 `SKILL.md`，名称排序后处理。先扫描 frontmatter，按 1 KiB 块读取，头部上限 64 KiB；不会为了展示候选就把每个技能全文塞进系统提示。

文件须为普通文件，YAML 使用唯一键和 alias 数量限制。描述长度为 1–1024，技能名称应与父目录名一致。realpath 用来识别同一文件的路径别名。后加载的同名技能获胜；获胜项被禁用后，不回退启用较早同名项。

列表返回副本，实际使用时重新读取并解析正文。系统提示只带技能元数据和路径；路径经过 XML 转义，技能中的相对资源引用以 SKILL.md 所在目录为基准。

## 系统提示合成

核心基础模板描述通用编码行为和工具。资源加载完成后加入指令及技能索引。SDK 的 `customInstructions` 可以是字符串数组，或返回字符串数组的同步函数；函数在资源加载后求值。它不是模板语言，不执行字符串中的任意表达式。

自定义 loader 的 `getBaseInstructions` 可以替代基础指令，`getInstructions` 添加补充指令；保留的旧接口只用于兼容。桌面提示再说明当前项目、桌面可用能力和协作约定，避免将整个工具 schema 重复写入文字提示。

## 刷新、禁用与出错

资源设置管理的是可用项和加载状态，修改磁盘文件后需要通过相应刷新路径重新加载。不存在文件与格式错误要区分：不存在是可选资源缺失，坏 YAML、非法 metadata、读取失败应显示诊断。

资源正文属于提供给模型的指令内容，并不赋予操作系统权限。技能不能让 SDK 获得 Electron，也不改变 shell 可访问的目录范围。工作目录、工具选择和桌面能力快照分别由各自状态 owner 管理。

## 源码与回归入口

- [加载器](../../packages/coding-agent/src/core/resources.ts)、[系统提示](../../packages/coding-agent/src/core/system-prompt.ts)、[桌面提示](../../packages/desktop/src/main/desktop-prompt.ts)、[设置界面](../../packages/desktop/src/renderer/ResourceSettings.tsx)。
- [发现测试](../../packages/coding-agent/test/resource-discovery.test.ts)、[技能测试](../../packages/coding-agent/test/skills.test.ts)、[自定义指令](../../packages/coding-agent/test/custom-instructions.test.ts)、[桌面资源](../../packages/desktop/test/resources.test.ts)。
