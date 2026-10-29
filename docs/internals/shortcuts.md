# 快捷键路由、注册与焦点

使用入口与默认按键：[快捷键](../features/shortcuts.md)。

## 单一动作定义

shared/shortcuts 定义动作、默认键、规范化和显示。设置页、菜单提示、主窗口、快速对话和原生视图都消费同一动作模型，不能各写一份按键字符串。历史默认键变更通过专门 migration，保留用户自定义选择。

全局热键由主进程注册，窗口内热键由 renderer 根据可见上下文执行。系统保留键或注册冲突不代表配置已成功，界面应显示实际注册结果。

## 改键事务

先尝试注册候选热键，再持久化，最后注销旧键；候选注册或持久化失败回滚。录制新快捷键期间暂停有关原生注册，结束后恢复，防止用户按下候选键时触发旧动作。

每个动作校验可用的 modifier/key 组合和冲突，不把 KeyboardEvent 的平台差异原样存进配置。显示统一用平台符号，执行统一按规范化形式匹配。

## renderer 路由

按当前可见 modal、菜单、查找栏、文件备注、终端、辅助对话与 composer 判断动作目标。隐藏或 inert 面板不能抢走输入。局部 Esc 先关闭自己的交互，只有未被更具体上下文消费的裸 Esc 才进入停止逻辑。

立即发送优先当前草稿，草稿为空时才处理队首。完整视图隐藏某个入口时，对应动作禁用。切回应用时保留仍有效的输入焦点，否则把焦点给当前 composer，不重置用户的有效选区。

## 浏览器 guest 与修饰键

原生网页 guest 不经过 React 的键盘事件，主进程需转发允许的应用动作。置顶等临时修饰状态由 before-input-event 和 input-event 同时维护，支持 macOS Meta 与其他平台 Control。

窗口失焦、隐藏、销毁及相应生命周期会清除修饰键；主窗口与内部 guest 的正常切换不能误清用户仍按住的键。不能只依赖 keyup，因为它可能发送到其他窗口。

源码：[动作模型](../../packages/desktop/src/shared/shortcuts.ts)、[主进程控制](../../packages/desktop/src/main/shortcut-controller.ts)、[修饰状态](../../packages/desktop/src/main/shortcut-modifier.ts)、[应用路由](../../packages/desktop/src/renderer/app-shortcuts.ts)、[composer 路由](../../packages/desktop/src/renderer/composer-shortcuts.ts)。回归：[注册控制](../../packages/desktop/test/shortcut-controller.test.ts)、[上下文](../../packages/desktop/test/shortcut-context.test.ts)、[停止键](../../packages/desktop/test/stop-shortcuts.test.ts)、[修饰键](../../packages/desktop/test/shortcut-modifier.test.ts)。
