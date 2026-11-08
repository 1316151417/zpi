# 结构化提问

使用入口：[协作与提问](../features/collaboration.md)。系统内置 questions 插件复用同包的 UserQuestions 服务，注册 AskUserQuestion 工具，属于当前会话首次发送时确定的插件快照。服务的构造、等待与取消由 BuiltinPluginRuntime 管理，宿主提供事件发布与会话接口。

## 参数和返回

一次 1–4 个问题，每题 2–4 个选项。header 长度 1–12，question 最多 8000 字符，label 最多 200，description 最多 8000，preview 最多 16000。问题文本和每题选项标签必须唯一，不允许自定义名为 Other 的选项，界面自带自由输入。

schema 要求 multiSelect；为兼容模型，prepareArguments 给遗漏值补 false，再执行完整校验。回答按 question 原文作为 key，允许跳过部分问题，答案及备注有各自长度和字段校验。返回工具结果包含 questions、answers、annotations 以及必要的自动结束标记。

## 状态机

每个会话的提问以 tool call ID 标识并按进入顺序排队，只发布队首 pending request。工具是 parallel 且 requiresUserInteraction：完整调用产生后可与同批独立工具并行，但不能在流式参数尚未结束时提前执行。多个提问仅在交互队列内互相等待，不把整批工具改为串行。

到达队首后才开始计时，排队时间不占用回答窗口。开始后前 60 秒为 hiddenGrace（自动结束提示的宽限阶段，问题本身仍可显示），随后进入 visibleCountdown。默认 5 分钟无答案时自动返回空 answers，说明应按最佳判断继续，不能虚构用户偏好或当成拒绝。snooze 清除计时器并标记 snoozed，不会把默认选项作为已提交答案。

响应必须匹配当前 request ID，过期提交报“提问已结束”。停止通过 AbortSignal 拒绝等待；finally 清除计时器、取消监听、移除自身队列项；队首结束后发布下一题并开始其计时，队列为空时发布 null。切换任务只改变显示位置，不改变问题所属会话。

## 维护时注意

参数 schema、主进程响应校验、UI 卡片和工具结果展示必须一起对齐。增加字段不能仅改 UI。问题超时行为是应用自身的工具约定，不能推广成任意批准请求的默认规则。

源码：[UserQuestions](../../packages/builtin-plugins/src/questions.ts)、[卡片](../../packages/desktop/src/renderer/UserQuestionCard.tsx)、[历史展示](../../packages/ui/src/components/AskQuestionToolBlock.tsx)。回归：[工具测试](../../packages/desktop/test/user-questions.test.ts)、[展示测试](../../packages/ui/test/user-question-presentation.test.ts)。
