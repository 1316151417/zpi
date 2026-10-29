# 提供商、模型配置与推理级别

使用入口：[模型与账号](../features/models.md)。协议细节见[请求转换](model-protocols.md)，登录见[ChatGPT 授权](openai-auth.md)。

## 三层对象

提供商是连接配置：ID、协议、base URL、凭据和公共 headers。模型是该提供商内的模型 ID、上下文窗口、输出上限、媒体能力、价格和推理选项。`ModelRuntime` 把两者合成请求时的 `Model`，最后由 `streamSimple` 按协议选择适配器。

模型 ID 相同不等于同一个模型配置；持久化选择使用提供商 ID 和模型 ID。订阅与按量 API 是不同提供商，不能因为品牌一样混用凭据。

## 预置与发现

[`registry.ts`](../../packages/ai/src/providers/registry.ts) 定义 OpenAI、DeepSeek、智谱、MiniMax、MiMo 的预置及协议地址。OpenAI 两种预置固定使用 Responses；其他内置预置允许 Anthropic Messages 和 Chat Completions，默认 Messages。自定义提供商可选择三种协议。

本地 [`catalog.json`](../../packages/ai/src/providers/catalog.json) 是模型元数据的随仓库快照，不是远端实时承诺。发现结果区分 `remote`、`catalog`、`defaults` 来源和 `listed`、`unverified` 可用性；发现列表与实际发起请求是两个阶段。手动配置的模型也需要正确填写能力，不能仅凭名称猜测图片支持。

环境变量发现按每个预置的 `envKeys` 顺序选择非空值，拒绝控制字符。凭据应由运行时解析，不进入模型列表、UI 快照或源码。桌面配置保存在 SettingsStore；SDK 可以注入 `apiKey` 或 `getApiKey(rejectedApiKey?)`。

## 配置合成

`registerProvider` 拒绝未知配置字段和非 chat 模型类型，校验推理映射。模型自身的协议优先于提供商协议；模型 headers 覆盖同名提供商 headers。注册更新保留未覆盖的提供商配置。`getAvailable()` 只返回配置了凭据、凭据解析器或自定义流函数的提供商中的模型；它不做付费额度探测。

桌面层负责把 UI 的设置转换成运行时配置，核心包不读取 Electron 设置、不打开登录窗口。自定义 `fetch` 默认走 HTTP，以便代理和测试能实际截获请求；只有显式设置 `responsesTransport: "auto"` 才恢复 WebSocket 资格。自定义 `streamSimple` 不走内置 Responses 长连接。

## 推理与采样

标准级别为 `off / minimal / low / medium / high / xhigh / max`。模型可通过 `thinkingLevelMap` 映射协议字段，也可以用 `reasoningConfig` 定义自有选项。等价 payload 的选项会去重；标准级别不可用时按配置中可用级别进行夹取，不会把不存在的级别直接传给服务端。

`option-map` 是独立的分词、解析、编译和求值器。它按受限表达式生成协议选项，不执行任意 JavaScript。修改支持的表达式时应同时检查编译诊断和运行时类型约束。

采样选项同时受模型配置、请求覆盖和协议兼容规则约束；例如 ChatGPT 授权请求会移除部分普通 API 采样字段。UI 显示一个选项，不代表三种协议的字段名称相同。

## 配置失效与缓存

切换模型、协议、凭据、headers 或有效上下文后，旧的传输会话不能凭模型名继续复用。Responses 连接另有身份指纹；参见 [WebSocket](openai-websocket.md)。工具声明也属于请求上下文，工具集合变化必须体现在系统事件里。

价格是估算元数据，缓存读写和普通输入分别计费；未知价格不能解释为服务端免费。推理 tokens 属于输出统计的一部分，不能再次累加到总输出。

## 源码与回归入口

- [运行时装配](../../packages/coding-agent/src/core/model-runtime.ts)、[桌面配置转换](../../packages/desktop/src/main/model-runtime-config.ts)、[模型发现](../../packages/ai/src/providers/discovery.ts)。
- [推理配置](../../packages/ai/src/utils/reasoning.ts)、[表达式编译](../../packages/ai/src/utils/option-map/compiler.ts)、[计费](../../packages/ai/src/utils/cost.ts)。
- [发现测试](../../packages/ai/test/model-discovery.test.ts)、[推理测试](../../packages/ai/test/reasoning-config.test.ts)、[协议切换测试](../../packages/desktop/test/protocol-switching.test.ts)。
