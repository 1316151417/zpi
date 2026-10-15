# 快捷键设置与浮层切换验收

参考 ZCode 本地源码 commit `aac4755666d09fdcd70272fcf063c077a639015f`，重点读取 `ShortcutSettingsSection`、`ShortcutSearchBar`、`ShortcutBindingRow`、两个录制 hooks、`SettingsPage` 和基础 Input/Button/Kbd。未修改参考项目代码。随后启动本地 ZCode 已有构建和 ZPI 当前构建，使用独立临时 HOME、应用数据与配置目录；未读取或覆盖用户快捷键设置。

## 实测视觉

两个 Electron 窗口设置相同内容尺寸，实际 viewport 都为 1280 × 893 CSS px。

| 项目 | ZCode | ZPI |
| --- | --- | --- |
| 标题起点 | 348.5 / 52.984 px | 348.5 / 53 px |
| 标题字号 / 字重 / 行高 | 30 / 600 / 36 | 30 / 600 / 36 |
| 内容宽度 | 832 px | 832 px |
| 搜索框宽 / 高 | 692.3125 / 28 px | 692.3125 / 28 px |
| 恢复按钮宽 / 高 | 131.6875 / 28 px | 131.6875 / 28 px |
| 表格列宽 | 323 / 323 / 80 / 72 px | 323 / 323 / 80 / 72 px |
| 单绑定行高 | 55 px | 55 px |
| 行内边距 | 12 / 16 px | 12 / 16 px |
| 键位单元最小宽 / 高 | 20 / 20 px | 20 / 20 px |
| 图标线宽 | 1.5 px | 1.5 px |

只在快捷键页指定 PingFang SC 中文字体回退，以匹配参考页面实际使用的字体，保留 ZPI 的 zh-CN 语义。颜色继续使用 ZPI 对应主题变量。实际参考构建的键位底色透明，按实际渲染对齐。标题纵坐标有 0.016px 布局舍入差异。

实际检查浅色、深色、640px 与 480px 窗口。480px 下页面宽度没有溢出，表格在自身区域横向滚动（480px 内容 / 357px 可视宽度），操作列仍可到达。

## 行为与自动验证

- 搜索命令名、快捷键文本及平台别名；按组合键过滤、Backspace 清除、Esc 退出、无结果及清空。
- 行内编辑、冲突候选和错误展示、Esc 恢复原绑定、清除后保留命令。
- 全部恢复默认的确认与取消，保留总开关；显式保存、失败不覆盖原配置、重试和重启恢复。
- 全局注册失败由控制器假 registry 覆盖，页面通过真实 preload/IPC 注入同类失败响应验证错误反馈与设置不变。
- 模型菜单（主任务和辅助对话）、环境菜单及分支搜索输入框、搜索任务、当前对话查找、任务菜单：打开 → 再按关闭 → 再按打开；长按重复被消费，焦点恢复，Esc 正常关闭。
- 新增 Command/Ctrl+U，打开现有任务三点菜单；↑↓ 导航，Enter 置顶与打开重命名弹窗，确认弹窗焦点正常。
- 录制时按 Command/Ctrl+U 提示冲突，不触发菜单。普通发送队首消息、隐藏辅助面板与终端快捷键回归通过。
- 新增任务菜单默认绑定不覆盖旧配置中的自定义 U；旧配置缺项只在内存补齐，保存才落盘，显式清空保持为空。离线旧设置迁移采用相同规则。

验证命令：

- `TMPDIR=/private/tmp npm run test:unit`：同步 main `3bfd88d` 并升至 0.2.59 后，177 个文件、1444 项全部通过。首次默认临时路径运行有 23 项失败，原因均为 macOS `/var` 与 `/private/var` 的符号链接路径差异；规范化临时目录后全部通过。
- `npm run check`：通过，仍有共享 UI 样式原有的 4 条 `!important` 警告。
- `npm run build`：通过，构建器仍报告依赖的 `use client` 指令提示。
- `npx playwright test tests/desktop/shortcut-settings-parity.spec.ts tests/desktop/composer-shortcuts.spec.ts tests/desktop/shortcuts.spec.ts tests/desktop/composer-menus.spec.ts`：0.2.59 最终构建的 12 个相关用例在一次完整定向运行中全部通过（40.4s）。修正了旧测试依赖遗留 JSONL 启动夹具、Tooltip 的 data-state 以及未等待菜单焦点移动的断言。
- `git diff --check`：通过。

## 保留的差异与未验证项

按需求保留 ZPI 的总开关、显式保存、17 条自身命令及默认键位、真实作用域和单绑定模型；没有移植 ZCode 的多绑定、冲突抢绑及其他设置模块。窄窗口增加工具栏换行与表格横向滚动。未绑定行仍提供编辑图标，便于重新录入。

本次消息未附可读取的两张截图，因此完成的是对本地源码及实际构建页面的测量对照，不能宣称已完成用户截图的逐像素验收。Windows/Linux 的物理键盘与原生窗口尚未实机测试；长按通过重复 KeyboardEvent 验证，系统级快捷键占用通过假 registry 验证，未占用真实系统快捷键。

交付截图位于本聊天的 visualization 目录：`zpi-shortcuts-light.png`、`zpi-shortcuts-dark.png`、`zpi-shortcuts-narrow-dark.png`、`zpi-shortcuts-narrow-unbound.png`、`zpi-shortcuts-conflict.png`，同时保留 ZCode 深浅色参考截图。
