# 项目、任务分组与 Git 工作树

使用入口：[项目和工作树](../features/projects.md)。

## 目录选择与组织状态

项目提供任务组织及默认 cwd。目录选择优先有效的项目根，包含当前隐藏项目的工作树关联；其次任务 cwd，最后 home。查询目录选项不应自动创建工作树或新任务。

任务标题、置顶、归档、分组和项目归属存放在业务数据库，不写成模型消息。拖动更新携带 sourceGroupId，服务端核对来源，防止陈旧界面把任务移动到错误组。分组修改使用事务，保留隐藏、归档和置顶成员的关系。

## 工作树创建

先用 Git 检查目录、仓库和 HEAD；不是 Git 仓库或没有提交时返回不适用。分支列表同时读取本地与远端引用，排除 symbolic ref。

创建目标只接受 HEAD 或校验过的 refs/heads、refs/remotes 引用。通过 `check-ref-format` 和 `rev-parse --verify --end-of-options ...^{commit}` 解析为一个确定提交，避免分支在后续步骤移动导致创建内容变化。

默认根位于 `~/.zpi/worktree/`，随机目录下再放仓库名称。目录预留最多尝试 32 次，随后执行 `git worktree add --detach`。Git 失败只清除空预留目录，保留可能已产生内容的部分检出，不能无条件递归删除。

Git 调用使用 execFile 参数数组，单次超时 30 秒、输出上限 1 MiB。分支、路径不拼接进 shell 字符串。已创建工作树与父目录关联是项目状态，不能靠路径 basename 推断。

## 外部编辑器与文件打开

项目工具栏保存工作区编辑器偏好，主进程根据平台定义和实际可用编辑器构造启动参数。renderer 只发送编辑器 ID 和受控路径，不能提交任意 shell 命令。图标与名称属于编辑器定义，打开失败返回 UI 错误。

文件预览右上角使用系统默认程序的路径独立于工作区编辑器偏好；文件管理器定位也有单独动作。不能把上次用 VS Code 打开项目误解释成所有 PDF、图片也必须交给 VS Code。

## 隔离的准确范围

工作树隔离 Git 工作目录和 index，仍共享仓库对象以及当前用户权限。辅助对话、子智能体默认共享父任务 cwd；只有显式创建/选择工作树才改变目录。它不复制未提交修改，也不是进程沙箱。

## 源码与回归入口

- [项目选择](../../packages/desktop/src/main/project-picker.ts)、[目录](../../packages/desktop/src/main/workspace-directory.ts)、[工作树](../../packages/desktop/src/main/worktrees.ts)、[任务分组](../../packages/desktop/src/main/task-groups.ts)。
- [工作树测试](../../packages/desktop/test/worktrees.test.ts)、[项目测试](../../packages/desktop/test/projects.test.ts)、[分组宿主测试](../../packages/desktop/test/task-groups-host.test.ts)、[目录 preload 测试](../../packages/desktop/test/workspace-directory-preload.test.ts)。
