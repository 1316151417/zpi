# Simplify — 2026-10-14

## 范围与流程

在 PR #16 合并并核对远端测试树后执行。按 `git diff @{upstream}...HEAD` 采集上一轮修复的统一 diff（24 文件、1428 行）；`git diff HEAD` 为空。四路独立只读审查 Reuse、Simplification、Efficiency、Altitude，全部完成后汇总去重，再应用等价清理。未展开新的正确性排查或添加产品能力。

## 采纳

- 分组刷新与成功回包排序复用 `appliedTaskGroupRequest`，删除只在同一分支变化的第二份 `taskGroupGeneration` 状态。失败命令、旧回包与刷新边界保持不变。此项由 Simplification / Altitude 同时发现，合并为一次修改。
- 输入框先识别实际 composer 快捷命令，再做可见弹层检查。普通字符、禁用快捷键、不匹配组合不再扫描 DOM 或读取布局；有效命令仍保留可见/隐藏弹层、IME 和重复键行为。新增一个回归覆盖这三类无须扫描的输入。
- 删除拖拽回归中已被 `toBeUndefined()` 断言排除的不可达更新分支，将实际不变的测试变量改为 `const`，保留全部输入和断言。

## 跳过

- 不为少量键盘事件字段复制扩展共享 matcher 的 `allowRepeat` API；这会触及本轮 diff 外的原生路由，收益不足，现有默认策略保持不变。
- 不强行合并不同作用域的拖拽浮层/侧栏样式、弹层选择器或增加通用导航抽象。Reuse 未找到应替换却未使用的既有 helper。
- 未发现具体大对象持有或长期闭包泄漏证据，不据此改为类、增加缓存或重构低频导航。

## 验证

- 定向 5 个文件、84 项测试通过。
- 完整 Node 单测：1050 通过、2 跳过；147 个文件通过、1 个跳过。
- `npm run check`、`npm run build`、`git diff --check` 通过；保留 4 条原有 CSS 警告。
- 采纳后的三项清理经独立只读复核，确认未扩展行为或修改范围。
- 发布版本 0.2.46，通过独立分支合并。GUI 环境限制沿用前轮，未运行 Electron GUI 或使用用户 Mac。
