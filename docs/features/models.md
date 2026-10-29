# 模型与账号

模型设置管理地址、凭据、协议和模型能力。主任务、辅助对话可以分别选择模型；快速对话有独立默认选择。

## ChatGPT 登录

1. 在模型设置选择 OpenAI（ChatGPT），开始登录。
2. 在浏览器完成账号和套餐访问授权。
3. 返回 ZPI 等待完成和模型目录加载。需要时可提交浏览器回调地址。
4. 选择可用模型发送简单消息。

登录使用 OAuth 令牌，无需粘贴网页 Cookie。目录获取失败时登录可能已经成功，按提示重试获取目录即可。取消后不会保存尚未完成的授权。

请求前自动处理令牌续期。退出先清除本地可用令牌，再尝试远端撤销；远端不可达时提示无法确认撤销。详见[认证与令牌](../internals/openai-auth.md)。

## API Key 与自定义服务

OpenAI（API）固定走官方 Responses 接口。其他预置通常提供 Anthropic Messages 或 Chat Completions，自定义服务还可选择 Responses。协议要与服务端实际接口匹配。

保存名称、地址、凭据和模型，按需刷新目录。启用、禁用和排序决定菜单内容。未知自定义模型需要核对 ID、上下文、输出上限、图片能力、推理和兼容参数。

预置显示名称和预算是客户端配置，不代表账号权限或服务端上限。OpenAI 预置和升级规则见[提供商原理](../internals/providers.md)。

## 思考程度和高级参数

默认优先使用可选项中的“中”，否则取中间项；已保存的手动选择保留。非推理模型不应配置不存在的推理档位。

高级配置支持请求参数和推理等级映射。参数错误可能让服务拒绝请求，修改前记录原值；出错后恢复最小可用配置。表达式边界见[提供商原理](../internals/providers.md)。

## 环境变量发现

启动时用预置变量初始化尚未存在的提供商，不覆盖已有配置。

| 服务 | 变量，按顺序取有效值 |
| --- | --- |
| OpenAI API | `OPENAI_API_KEY` |
| DeepSeek | `DEEPSEEK_API_KEY` |
| 智谱套餐 | `ZHIPU_API_KEY`、`ZHIPU_CODING_API_KEY`、`ZAI_CODING_CN_API_KEY` |
| 智谱按量 | `ZHIPU_PAYGO_API_KEY`、`ZHIPU_STANDARD_API_KEY` |
| MiniMax 套餐/按量 | `MINIMAX_API_KEY` / `MINIMAX_PAYGO_API_KEY` |
| MiMo 套餐 | `MIMO_API_KEY`、`XIAOMI_TOKEN_PLAN_CN_API_KEY` |
| MiMo 按量 | `MIMO_PAYGO_API_KEY`、`XIAOMI_API_KEY` |

macOS/Linux 尝试读取登录 Shell 环境。删除自动导入的提供商后，如果变量还在，下次启动会再次导入。只注释 Shell 文件不会清除已经运行的终端环境。

## 切换与保存

运行中改变选择不会改变已开始的执行，后续消息使用新配置。跨模型保留本地文本与工具历史，供应商专用推理字段按协议适配。切回 OpenAI 可能重新建连并发送完整有效上下文。

凭据在系统加密可用时加密保存；不可用时留在当前内存。公共设置和普通日志不承载完整密钥。网页搜索使用[独立凭据](web.md)。

下一步：[对话操作](conversations.md) · [诊断](diagnostics.md) · [协议转换](../internals/model-protocols.md)。
