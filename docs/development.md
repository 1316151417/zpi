# 开发与调试

安装和常用命令见 [README](../README.md)。使用 Node.js 24 和 npm；当前桌面构建与本地打包主要在 macOS Apple Silicon 上验证。

## 开发客户端

`npm run dev` 以 ZPI Preview 身份启动 Electron 和 Vite，与打包的 Preview 共用数据目录和钥匙串身份；正式版使用独立的 ZPI 目录。开发版与 Preview 应轮流运行。

界面修改通过 HMR 更新，内核、主进程及 preload 修改会自动重启客户端；Ctrl+C 结束开发进程。升级 Electron 后重新运行 `npm run install:terminal`。macOS 编译终端模块需要 Xcode Command Line Tools。

在 Electron 的 View 菜单打开 Toggle Developer Tools。主进程调试可使用 VS Code 的「ZPI: Electron main」配置；也可用 `ZPI_DEV_DEBUG=1 npm run dev` 开放本机 DevTools 调试端口。

## 本地数据与凭据

本分支使用 SQLite 存储当前业务状态，JSONL v2 存储会话事实。应用数据根的 `active-generation.json` 指向 `storage/<generationId>/`；该目录包含 `state.sqlite`、`credentials.enc`、`agent/sessions` 和受控附件等文件。设置、项目、任务、草稿、队列与分组从 SQLite 读取，不再加载旧 `settings.json`、`projects.json` 或 `task-groups.json`。附件仍保留专用文件与 `index.json`，不是所有 JSON 都被删除。折叠状态和视图选择仍是 renderer 本地偏好。分组不修改工作目录，删除分组不删除会话。

发现旧数据但没有已激活的新 generation 时，启动会拒绝继续，并要求离线迁移；不会自动转换或回退读取。可用 `ZPI_DATA_DIR="/absolute/path/to/trial" npm run dev` 覆盖数据根进行隔离试用（只隔离数据，不隔离项目或权限）。个人智能体正文保留为 generation 内 `agents/*.md`，启用/选择状态在 SQLite 的 `subagentProfiles` 配置中。完整合同、隔离试用、迁移命令与回滚限制见 [SQLite 存储说明](specs/sqlite-storage.md)。

macOS 数据目录：

- 正式版：`~/Library/Application Support/ZPI/`
- 开发版与 Preview：`~/Library/Application Support/ZPI Preview/`

凭据使用 Electron 系统加密；系统加密不可用时，只在本次应用内存中保留凭据，不以明文保存。没有遥测不代表模型请求不出网：当前上下文仍会发送给所选择的模型提供商。

### 环境变量导入

环境变量只初始化尚不存在的预置提供商，不覆盖已有设置。删除自动导入的提供商后，只要启动环境仍带有对应 API Key，下次启动就会再次导入。

注释 Shell 配置中的 `export` 不会清除已有终端的变量。应在启动终端中执行相应的 `unset`（例如 `unset MINIMAX_API_KEY MINIMAX_PAYGO_API_KEY`），或关闭旧终端后打开新终端，再删除该提供商并重启。

## 异常日志

日志位于应用数据根的 `agent/logs/error.log`；会话位于活动 generation 的 `agent/sessions`，两者不再是同一个根下的同级目录。每行是一个 JSON 记录，包含时间、来源、错误消息、可用堆栈及相关会话/运行 ID。

达到 5 MB 后轮换为 `error.log.1`，保留一份旧日志。日志仅存本机，不记录 IPC 参数、完整请求或聊天内容，并屏蔽常见凭据格式；日志写入失败不影响原有错误处理。

### 错误提示落点

主窗口的异常统一走 `Notice`（`packages/ui/src/components/Notice.tsx`），落点由 scope 决定：`input` 留在 composer 草稿里，供用户改完重试；`turn` 留在该轮消息末尾（运行失败随会话保存）；`window` 浮在主区域右上角，5 秒自动消失且悬停暂停；`config` 常驻标题下，修好配置后才消失。窗口提示挂在 `.workspace-surface` 之外，打开设置时仍然可见，并通过 `--right-pane-offset` 对齐主区域。同一个失败只出现一次，新增错误时复用这四个 scope，不要再发明位置。默认 `report()` 走窗口级；能就地重试的提交失败传 `{ input: sessionId, revision: draftRevision }`，版本不匹配的迟到失败只进带“上一次发送失败”上下文的窗口提示。

## 工具与会话边界

- `packages/coding-agent` 的默认工具是 `read`、`write`、`edit`、`bash`。SDK 用 `customTools` 增加工具，用 `toolOverrides` 显式替换同名基础工具，不依赖 Electron。
- 桌面端的 `SessionHost` 负责通过 `customTools` 注入 `AskUserQuestion`、子智能体工具与可选的 `web_search`/`web_fetch`，通过 `toolOverrides` 替换后台版 `bash`。子智能体通过 `Agent`、`SendMessage` 委派和沟通，通过 `RespondToCoordinator` 汇报；`TaskOutput`、`TaskStop` 统一读取和停止子任务与后台命令，关闭子智能体插件后仍提供这两个后台任务工具。
- 「插件能力」中的联网搜索、提问、子智能体和提示词选项默认开启，已有设置中的显式选择会保留。新对话首次发送时保存配置快照；之后修改全局开关不会重配已有对话。提示词开关不构成权限沙箱，也不会禁用底层并行执行能力。
- 第一项「提示词-交互方式」控制进展说明、最终回复的完整交付、表达方式及代码风格规则，独立于「提示词-主动推进」。升级后全局设置默认开启此项；已有对话缺失此项时保持关闭，继续沿用原有提示词。
- 辅助对话是用户手动创建的独立会话，只复制创建时的稳定上下文和配置。子智能体是桌面编排的受委派任务。两者都共享父任务的工作目录；Git 工作树只提供独立检出目录，不隔离操作系统权限。
- 后台命令和子智能体的通知只在工具调用结束、主模型还要继续调查时合入当前轮；纯文本答案期间到达的通知等本轮结束后单独启动，显示为带任务标题的「后台补充」。通知元信息随运行记录保存，重启后保持分组，原任务的完整答案不被后续短补充折叠。
- OpenAI Responses 的每段文本保留原始 `phase`（`commentary` / `final_answer`），同模型历史重放时原样回传；旧记录缺失标签时不猜测，切换模型时按既有规则移除供应商元信息。
- Responses 的文本结束、消息结束和响应结束事件均以完整正文校正片段；支持网关在 `stream: true` 下返回 `application/json` 或 `+json` 完整响应，复用相同的工具、用量、拒绝和失败处理，不重复请求。HTTP 200 不代表生成成功，仍须检查响应终态。
- Responses 缓存按官方[缓存规则](https://developers.openai.com/api/docs/guides/prompt-caching)分代处理：GPT-5.6 及更新模型的 `none` 使用无断点的 explicit 模式；`skipCacheWrite` 只在最后临时输入之前标记稳定前缀；`short` / `long` 均受当前仅支持 `30m` 的 TTL 限制。已确认支持扩展缓存的旧模型将 `long` 映射为 `24h`，支持短缓存的映射为 `in_memory`；GPT-5.5 不发送不支持的 `in_memory`。旧接口的 `none` 只能省略路由 key，不能关闭服务端自动缓存，`skipCacheWrite` 也不能控制旧接口边界。ChatGPT 认证保持现有旧 retention 参数限制，未知网关模型别名保持默认参数；定制控制可通过 `samplingParams` / `onPayload` 指定。缓存写入 token 从普通输入中分离，按模型配置的缓存写入价格计费。

### 联网工具边界

接口按 DeepSeek 官方[网页搜索与抓取指南](https://api-docs.deepseek.com/zh-cn/guides/search/)、[Search API](https://api-docs.deepseek.com/zh-cn/api/search/) 与 [Fetch API](https://api-docs.deepseek.com/zh-cn/api/fetch/)（2026-10-17 核对）实现。

主进程 `web-client.ts` 对接固定的 DeepSeek `POST /v1/tools/search` 与 `/v1/tools/fetch`，不使用 Harness 的辅助模型搜索协议，也不本地抓取网页。工具 schema 保留官方字段、可选性、`count` 1–50（默认 10）及 128 Unicode 字符查询限制；不自动补入原始问题或 IP。独立网页凭据位于 `credentials.enc` 加密载荷，常规 `PublicSettings` 只含是否已配置和解锁后推导的 `apiKeyLength`，锁定时长度为 0，不持久化长度副本。仅用户点击设置中的眼睛时，经现有 sender/mainFrame 校验的零参数 `getWebSearchCredentials` IPC 读取已保存 Key（停用服务仍可查看），不广播到全局 settings、不记录 key、不联网。renderer 将临时明文与用户替换草稿分开，隐藏、设置快照变化、页面隐藏/窗口失焦和卸载会撤销在途读取并清除临时显示；只查看不会成为待保存值。输入框和头部启停/菜单控件由模型与网页设置共享。`saveWebSearch` 省略 key 表示保留，空字符串表示删除。

两个操作分别在本 ZPI 实例中按 5 QPS 调度，不能控制同账号的其他客户端。单次工具执行总期限 30 秒（包括排队、响应读取和重试），仅对 408、429、5xx 最多尝试三次，不缩短服务器有效的 Retry-After；等待超出总期限时返回受控错误，取消不重试。响应最多 2 MiB；给模型的完整结果最多 32,000 字符，截断会明确标记。超出响应字节限制返回受控错误，不接受不完整 JSON。

Fetch URL 只允许无凭据的公网 HTTP(S) 地址，屏蔽本地/私有 IP 字面量与本地域名；本客户端不解析目标站点 DNS，DeepSeek 负责其上游 DNS 和跳转策略，因此这不是完整的客户端 SSRF 保证。带凭据 API 请求禁止跳转。网页结果是不可信资料，不能成为系统指令；渲染层禁用原始 HTML、远端图片和本地文件链接。过程行不加载站点图标。

联网工具沿用 ZCode `SearchToolCallBlock` 的 `canToggle=false`、`content=null` 语义，复用现有 `ToolLayout` 单行过程样式：搜索展示查询词，抓取优先展示实际目标 URL；保留进行中、失败、取消和完成状态，不显示展开箭头、结果列表或正文。旧记录保存的展开状态不再影响它，长文本在窄栏内省略；模型与持久化内容保持不变。

网页服务的启用选择与全局能力开关独立。新配置需要保存 Key 并显式启用；旧版本未保存服务状态时，只有成功解锁的独立网页 Key 才迁移为启用，锁定凭据延后迁移。全局开关缺失时默认开启，已有显式 false 保留；旧会话缺少冻结字段仍为 false。catalog、预览和首次发送统一使用「总开关 + 服务启用 + 凭据可用」的有效能力。已冻结的 true 会话仍在每次实际请求前（包括限流和重试等待之后）校验服务及本次捕获的凭据；停用、移除或替换 Key 后不继续重试，也不切换 Key 续跑。已发出的请求不追溯撤销，false 会话不会因配置变化扩大能力。

回复操作栏「来源」从当前 run、当前回复消息之前的成功 web 工具元数据派生，URL 去重并补全信息，不扫描其他轮次或子任务，不改变模型 payload。按钮最多显示五个不同 hostname，浮窗只显示有界纯文本摘要；点击来源通过 `forceInApp` 打开内置浏览器。来源随当前投影重新计算，session/run/answer 改变会关闭旧浮窗。

站点图标是独立的受限图片通路：renderer 只提交 session/run/source URL，主进程先在该轮已记录的成功搜索结果中查找 `site_icon`，再使用共享缓存。仅接受 HTTPS 默认端口；DNS 所有地址必须为公网，并将连接绑定到已校验 IP。禁止跳转和环境代理，不发送 Cookie、Authorization 或 Referer。总期限 5 秒包含排队、DNS、响应与解码，最多 4 并发、50 排队、256 KiB 响应、1M 输入像素；按实际字节识别 PNG/JPEG/GIF/WebP/ICO，再解码转为 32px PNG（最多 16 KiB），不依赖 CDN 可能错误的 Content-Type。ICO 目录最多 64 帧、每帧尺寸最多 256px，仅支持嵌入 PNG 或 40 字节头的未压缩 Windows BI_RGB DIB（1/4/8/24/32 位）；验证边界后解码单帧，并保留透明度。SVG、HTML、损坏或不支持的编码仍使用联网图标。缓存最多 128 项，失败短暂缓存；不使用第三方 favicon 服务。UI 只接收有界 PNG data URL，不把远端地址交给 img。

单元与集成测试全部使用注入的 mock transport 和隔离 HOME，不发送付费请求。联网设置交互使用 ReactDOM + Happy DOM 运行真实组件、DOM 事件、effects、Radix 菜单和弹层，并保留隔离 HOME；它不启动浏览器，也不提供布局/像素验收。Happy DOM 不合成浏览器 Enter/Space 的默认点击，键盘用例明确派发按键后补原生 click。真实桌面端验收仍需使用本指南的共享隐藏 Electron 测试启动器，不能把 DOM、SSR 或静态样式检查当作 GUI 验收。

### 快速对话的隔离边界

快速浮窗使用独立 `quick-chat` preload、`zpi:quick-chat` IPC 与非持久 Electron partition。主进程同时验证 sender 和 mainFrame；主窗口的 `zpi:call` 仍只接受主窗口。独立 `quick-chat.html` 轻量入口不初始化主任务 store、资源、输入历史或阅读位置持久化，完整 `Conversation` 仅在展开时延迟加载。主窗口 HTML 加载完成后延迟 1500 ms 隐藏预热，不阻塞或被启动流程 await；不显示窗口、不抢焦点、不创建 Agent 会话或发起模型请求。预热不触发会话过期检查。

远程图片和非 renderer 目录的 file URL 均被窗口网络层阻止；用户点击的 HTTP(S) 链接可显式交给系统浏览器。来源图标通过快速对话专用 IPC，按当前内存 session/run 中已记录的成功搜索结果授权 `site_icon`，不接受 renderer 任意指定图标地址。授权后复用受限图片加载器的公网 HTTPS、DNS/IP 绑定、禁跳转、尺寸与解码限制，renderer 只接收有界 PNG data URL；不会为图标放开普通远程图片。新对话或退出应用会取消旧会话的图标请求。

`QuickChatHost` 与 `SessionHost` 分离，使用 `SessionManager.inMemory`、`SettingsManager.inMemory` 和空的 `StaticResourceLoader`，不加载项目 AGENTS、技能或命令。通过 `session.prompt()` 直接发送文字及已校验的图片，避免 `/commands`、文件提及和 Shell 展开。执行层只注册核心 `read`、`bash` 与当前有效的 `web_search` / `web_fetch`，删除专用 `list/search`，不暴露 `write/edit`、结构化提问、子智能体或浏览器控制；未注册工具不能执行。新轮次重新检查联网工具设置，实际联网工具请求也检查服务与能力状态。这些联网开关不限制 `bash` 自行联网。

`read` 与 `bash` 直接使用核心工具，不保留快速对话专用文件工具包装或路径、敏感文件拦截，不自动扫描目录。`bash` 沿用核心实现的可选 timeout（默认不设超时）、取消和输出限制，大输出可能写入临时文件。**只读要求由系统提示词约束；`bash` 能读写本机文件或自行联网，工作目录不限制访问其他路径，这不是技术只读沙箱。** 默认 `~/Documents/ZPI` 只是工作基点，首次发送时若不存在会创建。没有创建正式任务、持久会话日志、项目索引或自动转正式任务的路径；不应把临时会话描述成绝不写盘。

图片仅由输入框的 `onPaste` 接收 `ClipboardEvent` 中的 image `File`，不主动读取系统剪贴板。专用 preload 的 `importAttachment(sessionId, file)` 只传文件名和字节，不接受本地路径；`readAttachment(sessionId, id)`、`removeAttachment(sessionId, id)` 与 `send(text, ids?)` 均通过快速对话 IPC，主进程校验当前 session 归属。附件存储独立保存在内存中，复用核心格式识别、解码、像素与压缩处理：单张源文件最多 10 MiB、单图 4000 万像素、每条消息最多 8 张及合计 8000 万像素。导入并发、待处理字节和已发送图片历史也有内存预算，超限提示移除草稿图片或开始新对话，不写入主任务附件目录。草稿缩略图不显示文件名，预览与删除按钮保留含名称的无障碍标签；处理与错误状态仍可见。预览和移除使用相同临时附件入口；文字配图与纯图片均可发送。当前消息或会话历史含图片时，非视觉模型必须在发送前报错，不能静默丢图。发送拒绝或模型返回失败时保留原草稿图片与文字；新草稿已改变时不以迟到失败覆盖用户的新输入。

图片的 128 MiB 上限是保守的准入预算：同时计入缓存源文件、处理后的字符串、在途导入及每次已接受发送的图片历史，并非堆内存实测值。同一附件再次发送（包括失败后重试）会再预留一份历史预算；已发送附件的缓存仍供历史预览和重试使用。移除草稿只释放未使用缓存，新对话清空缓存和历史预算。

快速对话默认模型独立保存在 `settings.quickChat.defaultSelection`，不读取或写入主任务的 `lastSelection`。设置变化从下一次发送起生效，运行中的模型快照不变；默认提供商、模型或思考级别不可用时回退首个可用模型的默认思考级别，无可用模型则阻止发送并提示去设置配置。会话只在内存中保留，不提供历史会话 UI；默认设置可以跨重启保留。

过期使用单调时钟，以最后一次被接受的用户发送为基点。经过 15 分钟后，仅在下一次用户唤起时 reset，取消旧 run 并进入新 session；隐藏、显示、预热、输出 token 和回复完成均不续期。未曾发送时不按此规则过期。普通隐藏保留未发送文字、图片草稿和当前回复；手动新对话或过期产生的新 session 清空草稿及所有临时图片，迟到的旧导入、读取或发送不得污染新会话。自动过期恢复紧凑状态；显式新对话仅在动作开始时原生窗口可见且已展开时保留展开；隐藏时新建回到紧凑输入。原生 renderer 重载或崩溃会丢弃未发送的文字和图片草稿，清除未使用的临时附件并废弃旧导入；已接受的历史图片仍保留，普通隐藏、失焦或 Space 切换不触发此清理。

紧凑浮窗初始为 `360 × 44 DIP` 的胶囊，不显示「＋」；`Shift+Enter` 换行和长文本自动折行会按 textarea 的实际内容高度向上增长，纯文字最高 `184 DIP`，图片处理/重试提示覆盖在缩略图底部而不预留文件名空行；多张图保持单行横向滚动。有图片时为 48px 缩略图行及 8px 间距多留 56 DIP、最高 `240 DIP`，继续输入时内部滚动，删除、字体或可用宽度变化后重新测量并收缩。renderer 通过专用 IPC 上报当前 session 的有界高度，主进程拒绝无效高度，忽略旧 session 或展开状态的紧凑缩放请求。首次有效发送后展开为 `660 × 560 DIP`，展开后的 textarea 最高 `160 px`，不会随输入继续放大窗口；发送按钮始终是 `28 × 28 px` 圆形。左上「＋」开始新对话并保留当次展开尺寸，无窗口关闭「X」，用 `Esc` 或快捷键收起。macOS 的独立全局命令 `quick-chat-new` 默认 `Alt+Shift+Space` / Option+Shift+Space，普通 `quick-chat` 默认 `Alt+Space` / Option+Space；Windows/Linux 分别为 `Alt+Shift+N` 和 `Alt+N`。两者的语义分开：

- 普通快捷键只管理显示/收起，不重置或停止回复、不清草稿；也可取消 pending 打开。
- 新建快捷键在隐藏、未创建时新建并显示紧凑输入；可见且有历史（包括运行中或错误）的窗口直接安全重置，可见大窗当次保持展开。
- 可见聚焦且没有历史时复用 composer probe，只把 renderer 明确报告的空白视为再次收起。文字、任意状态图片（排队、处理中、失败、移除中）、待处理操作或可重试错误都属于内容，执行新建。250ms 未回复也按明确的新建意图重置，不把未知当空白收起。这一分支增加一次短时查询，不作性能保证。
- 新建仍在 probe、加载、重置或新会话帧确认中时合并重复按键，旧原生大窗仍可见且聚焦也不例外；已开始的过期重置直接复用，普通恢复未重置则升级为新建。左上「＋」的 reset 与显式 newConversation 仍无条件新建；新建键可加入「＋」尚未完成的 reset/帧等待。
- 原生窗口可见但未聚焦（包括 Space 事件交错）重新唤起，避免把另一 Space 的窗口当作当前已显示空白而收起。新建仅在动作开始时原生可见且已展开时保留展开。

pending 操作按 visibility epoch 归属，旧 promise 结束不得清掉后一次打开。probe 同时核对 session、epoch、窗口与 presentation version，隐藏、重置、session/模式/导航变化和销毁使旧回复失效；probe 后再次检查 host 是否已有 run。重复快捷键仅由初始操作报告失败；加入「＋」的快捷键不重复报告 reset 错误，但仍报告自己的后续呈现错误。renderer 同步读取 textarea 和本地图片/操作 ref，不持续上传草稿或维护另一份内容状态。空白回复已发出后用户才输入、随后窗口收起的短暂跨进程竞争仍可能发生，此时只隐藏、不清内容，普通快捷键可恢复草稿。

两项均可在快捷键设置修改、清空或禁用，缺失的新命令仅在默认组合未被占用时补入。快照的可选 `expanded` 字段由主进程统一决定呈现形态。可见大窗新建后当次保持展开；空白大窗收起后普通唤起回到紧凑输入，有文字、任意状态图片、待发送操作、可重试错误或历史时保留展开。紧凑草稿不会仅因有内容而展开。普通恢复仅在隐藏、展开且没有历史时查询当前占用布尔值；250ms 无回复保守保留展开，不销毁草稿。此恢复策略不同于上面的明确新建策略。普通历史恢复不查询或复制整个快照。窗口发布的单调快照版本阻止迟到旧 getSnapshot 回盖；独立呈现版本仅在模式或 session 改变时增加，帧后确认匹配 session 和呈现版本，折叠或过期后的旧布局不直接显示。新建、隐藏、Space 变化和销毁会取消旧等待；新建所用呈现意图在动作开始时捕获，等待重置期间的显示/隐藏不改变该意图，后一次新建意图覆盖前一次。冷启动、隐藏时新建和自动过期均回到紧凑状态，流式更新不反复缩放。对话布局只在 `.quick-chat` 范围覆盖：首轮顶部 8px，后续轮次顶部 12px，各轮底部 16px，主任务样式不变。

使用公开 display `bounds` / `workArea` 的底部 inset 估算底部 Dock 高度，让窗口底边在 Dock 上方再留约一 Dock 高；紧凑输入增高或收缩时保留这个底边锚点。底部 inset 不明显的侧边/自动隐藏 Dock 使用 64 DIP 间距。所有窗口坐标以 DIP 计算，当前显示器水平居中并限制在 workArea 内；小屏限制尺寸和位置，必要时优先保证不超界，不能保证仍保留完整 Dock 间距。textarea 超过实际可用高度时内部滚动，不提供手动缩放。

已加载且未过期的保留窗口直接在唤起调用栈中执行 `show` / 必要的 `focus`，没有额外 `await`；相同 bounds / minimum size 不重复设置，重新唤起不重发整个会话 snapshot。renderer 在 session 或呈现版本变化的 IPC 边界用 `flushSync` 同步提交：替换 session（包括过期）时将清草稿、图片、待发送状态及新快照一起提交；同 session 的模式变化保留草稿，普通同版本流式快照仍保持批处理。提交后的 `requestAnimationFrame` 内排入零延时 task，等这次渲染机会结束再确认，省掉原来等待第二次 vsync 的步骤。不能用 Promise/microtask 代替该 task，也不能在首个帧回调前用定时器兜底显示。更新或卸载会取消旧帧及排队 task；取消、Space 变化或旧 session/版本确认不能重新显示已收起窗口。确认超时会丢弃旧 renderer，下一次唤起重建。该边界保留 DOM 更新后至少一次渲染机会，和原双帧一样不证明操作系统合成器已经完成绘制，不承诺零延迟。调度依据：[HTML rendering task](https://html.spec.whatwg.org/multipage/webappapis.html#update-the-rendering)、[React flushSync](https://react.dev/reference/react-dom/flushSync)。

针对 0.2.91 基线的窗口替身可稳定重现一个事件顺序缺口：在 `show()` 调用栈内发出 `blur`，旧处理会立即隐藏并使后续 `focus` 无法执行，连续三次唤起均失败。本轮把显示期间的失焦复核推迟到同步焦点步骤之后，同时核对窗口身份、可见性 epoch 与实际聚焦状态；迟到的 `hide` 也先核对原生可见状态。真实失焦仍收起，旧事件不得撤销新的显示意图。这个模拟复现证明代码对该事件顺序的处理有缺口；尚未在真实 Mac 采到同一事件序列，不能据此宣称已经确定用户机器上快捷键症状的真实根因。

本地诊断默认关闭；启动 ZPI 时显式设置 `ZPI_QUICK_CHAT_TIMING=1` 才记录，开发启动示例为 `ZPI_QUICK_CHAT_TIMING=1 npm run dev`。输出位置是 Electron `userData/agent/logs/quick-chat-timing.json`，最多保留当前进程的 64 条记录、文件上限 128 KiB，不上传。记录字段仅允许固定种类、冷/加载中/热启动模式、结果、阶段、实际快捷键及注册版本、临时 session 标识、呈现/renderer 版本、visibility epoch、opening 阶段、等待数量、原生可见/聚焦/展开及显示意图，以及进程单调/相对毫秒；不包含消息/草稿、session 正文、文件路径、URL、模型密钥或绝对时间。这里的 `userData` 路径是输出位置，日志内容不包含用户路径。写入在唤起调用栈返回后排队，失败不阻止浮窗。

计时种类用 `new` 区分显式新建与普通 `open`。新增 `reset-start` → `reset-ready` 记录主进程重置（包含运行中停止），`session-frame-wait` → `session-frame-ready` 记录等待当前 session/呈现版本确认；两段可用于区分清理和 renderer 准备延迟，后者包含 IPC/React/帧调度，不等于像素显示时间。其余阶段区分预热、创建/加载、过期检查、几何、`show` / 原生 show 事件、`focus` / 原生 focus 事件，以及 renderer ready、输入框焦点、帧回调和 `native-keydown`（仅记录到达，不记录按键内容）；固定隐藏原因包括快捷键、Esc/IPC、真实失焦、Space 变化及被忽略的迟到事件。记录不是持续系统追踪，`renderer-frame` 只代表双帧回调而非像素显示证明，缺失确认或超时也不能当作成功。分析时应分别观察冷启动、热唤起与过期重置，结合实际可见性/输入焦点复核，不把模拟计时换算成原生快捷键延迟。

macOS 保持 Electron `type: "panel"`，不设置主窗为 parent。显示面板后，由 `quick-chat-focus.node` 记录前台应用并调用 AppKit 激活本进程，再聚焦面板；不能因 `isFocused()` 已为 true 而省略激活，原生 key-window 标记不保证实体按键进入该进程。原生模块使用 Node-API 与公开 AppKit API，不访问 Electron 的窗口句柄。主动收起及截图前隐藏（toggle-hide / ipc-hide / native-close / capture-hide）且面板仍可见并聚焦时，先归还本次唤起前应用的焦点，再隐藏面板，避免 Cocoa 把主窗提到前台；不隐藏整个应用，也不改变主窗的显隐或窗口顺序。归还对象在首次激活时捕获，重复呈现不覆盖；目标已退出或用户已切到其他应用时不激活它。归还失败仍执行面板清理，旧清理不能隐藏重入的新唤起。失焦、Space 变化、程序收起及后台测试不归还焦点。Dock/主窗快捷键仍显式显示主窗。原生模块在首次唤起时延迟加载并校验导出；加载或激活失败记录一次错误后降级为 Electron 应用激活，不阻止主应用启动。归还焦点的异常记录后继续隐藏，不能同步逃出原生事件或快捷键回调。降级只保证应用可用，不保证原模块失效时仍保持同样的窗口顺序。原生模块在 macOS 构建时使用 Node.js 24 安装前缀下的 `include/node` 与 Xcode Command Line Tools 编译，随 `dist/native/*` 打包并解包到 asar 外。

面板本身覆盖所有 Spaces，配合失焦隐藏与 `NSWorkspaceActiveSpaceDidChangeNotification` 在切换 Space 时隐藏，避免把 `isVisible` 误当当前桌面可见证据；普通隐藏不取消请求。订阅仅在 macOS 注册并在退出时移除。显示器几何仅用于位置，Space 行为依赖原生面板。依据：[Electron panel](https://www.electronjs.org/docs/latest/api/base-window#new-basewindowoptions)、[Electron 41.10.7 非激活 Show/Focus 实现](https://github.com/electron/electron/blob/v41.10.7/shell/browser/native_window_mac.mm)、[Apple 焦点让渡](https://developer.apple.com/documentation/appkit/nsapplication/yieldactivation(to:))、[workspace 通知 API](https://www.electronjs.org/docs/latest/api/system-preferences#systempreferencessubscribeworkspacenotificationevent-callback)、[Apple Space 变化通知](https://developer.apple.com/documentation/appkit/nsworkspace/activespacedidchangenotification)。不要用 `setVisibleOnAllWorkspaces(true/false)` 的临时切换替代这套行为：panel 自带 all-Spaces，额外调用可能转换整个应用的进程类型。

受控性能回归使用真实 React 与窗口控制器、模拟 session 投影和原生窗口、16ms 帧间隔及 0ms task；在隐藏空白和隐藏已完成历史两种情况下，snapshot 分发均在逻辑时刻 0，`rendererReady` / 模拟 `show` 从 32ms（两个帧机会）降为 16ms（一个帧机会后 task）。这是调度预算验证，未计入真实 IPC、OS/Chromium 调度或绘制成本，不能作为 Mac 延迟实测，也不能据此认定用户的明显卡顿已全部解决。真实环境应分别记录空白/历史 idle 的 `new` 诊断及实际输入可用时间；该受控帧测试当时未运行 Mac 原生验收；0.2.113 的本机记录见下。

快速对话 Esc 在运行中调用现有 stop；send IPC pending 时将 stop 排在其后，操作归属确保 send 的 finally 不清理 stop，新会话会失效旧排队停止；停止 pending 时忽略重复 Esc，idle 时隐藏。监听跟随 running 更新，操作状态读取当前归属记录，继续忽略 IME、按键重复和菜单/对话框内部 Esc；新建/reset pending 仍可隐藏，不因停止保护而阻止取消显示。

快速对话复用 composer 的「立即发送消息」快捷键解析及设置，默认 `⌘Enter` / `Ctrl+Enter`。独立 `send` IPC 的可选 `immediate` 参数由主进程校验，再进入 QuickChatHost 的校验、停止、发送流程；取消期间拒绝重复发送，会话重置或关闭会使旧发送失效。沿用现有草稿与图片提交状态，失败保留输入，发送确认不清除较新的编辑；普通 Enter 仍只在空闲时发送。

快速对话 0.2.120 的独立审查复核、修复范围与原生截图焦点对照见 [审查验收记录](evidence/quick-chat-review-20261018/README.md)。已聚焦的可见窗口带入内容时保留位置，隐藏或未聚焦唤起仍按原策略选屏；普通恢复在 reset 完成后判断新会话是否空白，探测超时继续保留草稿。

快速对话测试应覆盖工具 allowlist 与真实 `bash` 边界、内存会话与 15 分钟过期、文字/图片草稿清理、图片尺寸/数量/像素/内存预算、跨 session 与迟到导入、失败重试、纯图片/多模态 payload、含历史图片的非视觉模型拒绝、独立默认模型与 fallback、两组快捷键冲突恢复、IPC/来源图标/导航边界，以及 Happy DOM 的紧凑输入高度上报、发送按钮、左上新对话、无窗口关闭按钮、IME、设置导航和默认模型选择。窗口模拟验证普通快捷键的打开/收起/恢复，以及新建键的隐藏新建、可见有内容新建、已呈现空白再次收起、新建 pending 的连续按键合并、普通 pending 恢复升级为新建、旧操作 finally 不干扰新打开、失败去重与重新打开、迟到重置与帧确认、隐藏不清草稿/停止请求、DIP 几何与底锚点、预热不显示或抢焦点、加载时收起、可见但未聚焦的再次唤起、show 栈内 blur、迟到 blur/hide、过期帧后确认/取消/超时、Space 通知及清理；诊断验证默认关闭、字段白名单与记录/字节上限。Happy DOM 和窗口模拟不证明真实 macOS 全局热键、Space 切换、跨应用焦点、像素布局或真实模型服务可用。

原生验收：用隔离测试配置运行 `tests/desktop/quick-chat.spec.ts`（44→184 DIP 文字及最高 240 DIP 图片草稿增高、内滚、删除收缩、底锚点、圆形发送按钮、展开输入 160px、首轮/后续轮次间距、合成 paste→附件 IPC→fake provider 多模态/纯图片、预览移除、失败保留、历史图片模型校验、Esc 隐藏/重载、后台隐藏窗口新建回紧凑及主任务隔离），显式交互测试可运行 `tests/interactive/quick-chat-focus.spec.ts`（隐藏主窗时浮窗取焦点、文字/图片草稿增高底锚点、合成图片粘贴与恢复、连续三次 Esc 隐藏/唤起）。两者仍使用 app API，不注册真实全局快捷键。另在 Mac 手动将主窗留在桌面 A、当前应用放在桌面 B，按 Option+Space 应只在 B 出现输入框且不切回 A；再次按应收起。浮窗隐藏时按 Option+Shift+Space 应显示空白紧凑输入框；保持空白再按才收起，Option+Space 恢复仍为空白。已有回答的大窗按 Option+Shift+Space 应在同一大窗开始空白会话，随后 Option+Space 收起再恢复应是空白紧凑窗，不能回到老会话。有文字、图片或导入中草稿时按新建键应清空并新建；普通 Option+Space 收起/恢复仍保留它们。初始化、probe、重置或等待新会话帧时连续按新建键应保持同一次打开，即使旧大窗仍可见也不反复取消或重置。Esc、关闭、Space 切换仍取消 pending 展示，迟到确认不能重新弹出。原生大窗可见但已失焦时，新对话快捷键应重新唤起并保持 660 × 560 DIP。点击可见大窗口左上「＋」应当次保持展开；不输入任何内容，连续隐藏/Option+Space 恢复应稳定回到紧凑输入；分别保留文字、图片处理中/失败/待发送草稿再恢复应保持展开，删空全部草稿后再隐藏恢复应回到紧凑输入。已有回答的普通 Option+Space 仍恢复原会话。分别从截图工具和其他应用复制图片，使用系统粘贴确认预览、移除、纯图片及文字配图，再检查收起恢复与发送失败保留。发送后切到桌面 C 应收起，再按应在 C 展开并保留回答，连续重复至少三次并确认可立即输入；发生失败时保留上述本地诊断，核对实际事件顺序。重复全屏 Space、多显示器、底部/侧边/自动隐藏 Dock、小屏、输入法候选、打开回答链接和流式停止/新对话流程。确认隐藏预热不显示、不抢焦点，也不发起模型请求；超过最后一次发送 15 分钟后再次唤起应进入空白紧凑输入框，旧内容、文字和图片草稿不能短暂闪现。

0.2.113 已在本机真实 macOS 面板中复现隐藏后的迟到 blur 取消新唤起，并通过实体全局快捷键定位到空闲 reset 的无效 await。opening 现在区分隐藏准备与已呈现，空闲 reset 在预留并发 promise 后同步发布新 session；运行中取消仍等待完成。诊断进一步记录 shortcut-register/received、host-stop/dispose/selection/published、snapshot、React commit、ACK 及 opening phase，commit IPC 只在诊断开启时发送。实体键盘前后计时、用户反馈、原生重复回归及尚未验证的边界见 [本机验收记录](evidence/quick-chat-lifecycle-20261018/README.md)。

0.2.114 补充实体键盘复现「历史大窗新建→普通隐藏→普通恢复为紧凑窗」：已收到全局快捷键，但 warm `ready` 的 Promise 链在首个 composer IPC 前空等 1042ms；probe、折叠和帧确认随后很快完成。已就绪且无需 reset 的窗口现在直接进入准备函数，在快捷键调用栈发出探测。草稿保护、超时、session/epoch 校验和折叠帧确认不变。同机前后及原生回归见 [紧凑恢复验收记录](evidence/quick-chat-compact-resume-20261018/README.md)。

0.2.112 在未修改的 0.2.111 上用真实 React QuickChat + 窗口控制器重现：可见历史大窗按新建键后 session 未改变、旧对话仍保留。修复覆盖历史/运行中大窗完整新建→隐藏→普通恢复流程、紧凑与展开文字/图片/导入/失败草稿、空白二次收起，以及可见 pending 的连续 8 次按键和「＋」帧等待合并。主进程 probe 超时、版本/session 替换、取消与失败重试有确定性单测；没有运行原生 Mac 或性能验收。

0.2.111 的回归测试在未修改的 0.2.110 窗口实现上重现：重置尚未完成时连续按两次新建键，随后重置完成并确认当前会话帧，空白和有历史两种情况都没有调用原生 show。修复后覆盖加载、重置和帧等待期间的 2/3/4/8 次按键序列。这是窗口替身的确定性复现，不证明用户 Mac 的全部事件顺序或原生验收通过。

0.2.112 及以前的上述云端记录仅更新这些原生用例并做静态校验/`--list` 发现检查，当时没有运行 Electron GUI、真实 API 或用户 Mac；macOS Space/Dock/跨应用焦点、真实系统剪贴板图片与粘贴、真实全局快捷键事件顺序与原生毫秒延迟均未实测。不能将脚本更新、DOM/窗口模拟通过或 `--list` 成功写成原生验收通过，不承诺 0ms。

0.2.117 在本机复现了 VS Code AX 选区不可用与面板自报聚焦却收不到实体键盘事件。C 改为用户确认的复制并保留剪贴板；面板显示后显式激活应用、重新取焦点。实体输入、长文字末尾与跨 Space 的前后对照、模态错误框替换和验证边界见 [选区与焦点验收记录](evidence/quick-chat-selection-20261018/README.md)。

### macOS 快速对话内容带入

`quick-chat-screenshot` / `quick-chat-selection` / `quick-chat-clipboard` 默认分别为 Option+Shift+A / C / V；其他系统默认不绑定。读取旧设置时只补缺失命令，冲突时留空；自定义、清空项和总开关保持不变。快捷键读取内容后才唤起，追加当前草稿，不新建、不自动发送。单次采集期间连续按键合并，显式新建后的迟到采集丢弃；窗口的单次交付同时核对 session 和 visibility epoch，隐藏或重置取消待领取内容。renderer 领取后再走原有图片导入、预览、限额与错误重试管线。成功带入会提交合并草稿、把光标放到最后并滚动到末行，方便继续输入。

截图调用 macOS 自带的交互式框选工具，按 Esc 取消；输出放在独立临时目录，成功、失败和取消均清理。截图前收起浮窗但保留草稿。V 只读取已有剪贴板，图片优先于其附带文字。C 按用户确认的新语义，由 AppKit / ApplicationServices helper 向按键时的前台进程发送一次 Command+C；不依赖目标编辑器的 AXSelectedText，不更改编辑器设置，不还原复制后的剪贴板。C 沿用来源应用的复制行为，VS Code 无选区时可能复制整行。

C 记录原剪贴板 changeCount，按需轮询到首次更新且拿到稳定文字便立即返回；1 秒期限只用于应用未响应复制的失败边界，不是固定等待。不清空剪贴板，不接受未更新的旧内容，读取中剪贴板再次变化则继续核对，切换前台应用时取消带入。无更新、非文字、空文本或前台变化时静默结束；未授权或超限在浮窗内提示。采集错误通过现有单次交付通道在浮窗内展示，保留草稿，不使用同步系统错误框阻塞回调。不会自动向模型发送采集结果，也不记录文本或图片内容；诊断仅含 draft-offered / draft-taken 等状态事件。

macOS 构建通过 Xcode Command Line Tools 的 clang 编译 `packages/desktop/native/copy-selection.m`，产物位于 dist/native，打包时解包到 app.asar.unpacked；运行用户无需编译器。编译至临时文件后原子替换，避免构建期间截断正在使用的助手。`npm run dev` 与 `npm run build` 均准备该助手。默认桌面测试禁止真实复制、截图和剪贴板采集；单测注入假读取器和命令执行器。原生交付集成用例使用真实 Electron、preload 和 renderer 追加测试文字/PNG；系统权限、实体全局键和实际截图/复制另做手动验收。

### 文件工具的资源与并发边界

本地文本 `read` 以流式扫描计算行数和内容哈希，仅保留当前输出范围的有界内容；超长单行也不整行缓存。为了精确的续读提示和内容复用判断，仍会扫描全文件，分页不等于只读取请求范围的磁盘字节。自定义 `ReadOperations` 保持原有接口，由实现方负责读取资源限制。

`write`/`edit` 对同一文件的 ZPI 内部写入排队。`edit` 在写入前再次核对原始内容，发现编辑准备期间的外部变动就拒绝写入，要求重新读取；这不是跨进程原子锁，最后一次核对与实际写入之间仍有竞争窗口。`write` 保持明确的整文件覆盖语义。

文件预览卡片只请求变更元数据。较大的差异按需读取，单文件预览只计算该文件；同步 diff 算法在串行的一次性工作线程中运行，完成、失败或会话宿主关闭时清理。这样避免阻塞主线程，不代表复杂 diff 的总耗时消失；元数据查询仍读取有界快照以保留一致性检查。

### Bash 生命周期

SDK 原生 `bash.timeout` 使用**秒**，不传时没有默认超时；超时或取消会终止命令。桌面覆盖实现使用**毫秒**：前台默认等待 120,000 ms，工具参数最大 600,000 ms；超时可转后台，单独以 `sleep` 开头的命令则终止。`run_in_background` 显式转后台后立即返回任务 ID。

SDK 本地 Bash 在输出文件背压时暂停 stdout/stderr，排空后恢复。自定义 `BashOperations` 必须等待 `onData` 返回的 Promise 后再发送下一块数据；旧实现仍兼容，但忽略这个约定就无法保证待写缓冲有界。

后台进程跨主任务回合保留。中断主任务当前回合不会清理已转后台的命令；`TaskStop`、停止子智能体、归档/删除会话和正常退出应用会清理相应进程树。异常退出后不能保证子进程已清理；重启仅恢复历史并把原运行中任务标记为失联，不重启任务，也不凭历史 PID 杀进程。

输出直接落盘，模型输出预览有长度上限，侧栏按需读取末尾 64 KiB。前台与后台命令的输出文件都受 5 GiB 软上限保护（每秒检查，可能短暂超出）；子智能体命令转后台后最多运行一小时。`TaskOutput` 默认等待 30,000 ms，最长 600,000 ms；`block=false` 立即返回。运行中的输出预览保留开头，已结束任务保留末尾，避免漏掉最终错误。完成结果会自动回传，避免反复轮询。

侧栏终端和浏览器视图由主窗口持有。重载主窗口或渲染进程崩溃时，会终止侧栏终端的 PTY 并关闭原生浏览器视图，不自动重挂。通过 `bash` 工具启动的后台命令由会话独立管理，沿用上述后台任务生命周期。

实现入口：[SDK](../packages/coding-agent/src/core/sdk.ts)、[默认能力](../packages/desktop/src/shared/config.ts)、[会话装配](../packages/desktop/src/main/session-host.ts)、[后台命令](../packages/desktop/src/main/background-tasks.ts)。

输入框的临时错误提示在正常对话和快速对话中统一为发送按钮旁的单个感叹号：浮窗自动展示 3 秒，图标在 8 秒后收起；悬停或键盘聚焦时保留，发送消息时清除。需要重新加载的连接错误保留操作入口，回合错误与配置提示继续保留。快速对话在图标存在期间保留浮窗空间，悬停显隐不再反复调整原生窗口高度；输入框按测量高度贴底，图标消失时即使原生窗口延迟收缩，也不会暂时拉高输入框。

## 测试

文件入口、聊天文件预览和单文件 Diff 统一由 `FileManagerPane` 持有预览／目录布局，内容仍复用 `FilePane` 和 `ChangesPane`。目录显隐偏好按工作目录共享；桌面端始终保留预览与目录的可拖拽分栏，选中文件不自动收起目录。两栏的最小宽度取 160px 和面板宽度三分之一中的较小值，目录最大占 60%，窄面板也能拖到各占一半；预览不可折叠，旧的目录占满布局会按这些约束恢复；目录范围是整个工作区，“仅显示变更文件”依据工作区 Git 状态，不依据某一轮快照。导航由 pane store 更新当前标签页，保持标签 ID、任务归属和工作目录；从 Diff 导航到文件后变为普通文件预览。重开来源按当前内容查找可复用标签，不能按旧 ID 覆盖已导航的页面。审查入口继续展示改动集合。预览右上“使用默认程序打开”通过 preload 的 `fileAction(..., "open")` 使用系统文件关联，与聊天文件菜单保持一致；不读取项目编辑器偏好，也不依赖编辑器发现结果。项目工具栏的编辑器选择仅影响项目打开。文件树菜单使用 Lucide `FolderOpen`，聊天文件菜单的 Finder 图片继续复用 ZCode 素材。相关验证为 `pane-isolation.test.ts`、`changes-pane-dom.test.ts`、`workspace-editor-dom.test.ts` 和后台 Electron 的 `tests/desktop/file-manager.spec.ts`，后者包含明暗主题截图及窄布局。

### 模型性能统计

「界面设置 → 显示模型性能与用量」默认开启，缺失配置采用默认值，已保存的关闭选择继续保留。统计放在主对话和辅助对话输入框白区下方的现有底部留白内，采用 10px 字号、10px 图标和 12px 行高，出现或隐藏时不改变输入框位置、高度和底部间距。两组可点击读数为：`1 轮 3 步 · 85 tok/s`、`12.2K tok · 缓存命中 80%`；窄面板下单行截断，点击查看完整详情。会话统计详情显示轮数、步数、模型用时、工具调用用时、首 token 平均（TTFT）和输出速度（TPS）；Token 用量详情显示总量、缓存命中、未缓存输入、缓存读取、非零缓存写入、输出。数值格式参考 [DeepSeek Harness 5719020](https://github.com/deepseek-ai/deepseek-harness/blob/571902028a75c64c1d767f4ae5fd099485f0ddf0/packages/client/ui-chat/src/client/chat/StatsPills.tsx)。

统计范围是整个任务，包含多次用户发送和各次模型请求。新一轮不清空；与参考界面一致，只在请求结束或工具调用结束时更新，流式生成时保持已有值。每个任务仅在现有 SQLite 任务数据中保存一组累计计时与计数，不保存请求上下文；重启、视图和执行会话缓存淘汰后仍恢复。辅助对话独立统计，标题生成和子智能体不并入父任务。自动/手动压缩请求计入本任务。

轮数是至少结束过一次模型请求的用户交互数；步数是结束的模型调用数（含失败/取消，HTTP 内部重试不额外计步）。平均 TTFT 是成功请求从实际发起至首段非空文本、思考或有效工具调用增量的耗时算术平均；空事件、连接和本地占位不触发。模型用时为成功请求总耗时；输出速度采用参考实现的首段内容至完整响应结束区间，按有效输出 token 总和除以对应区间总和计算，不包含首段等待、工具执行或请求间等待。失败、取消、长度截断的时延和速度样本排除，每次 HTTP 尝试独立计时。工具调用用时是配对开始/结束事件的累计耗时，并行工具各自计时，故可能超过任务墙钟时间。

用量独立累计服务商已报告的实际计费数据（包括有用量的失败尝试）。总 token = 未缓存输入 + 缓存读取 + 缓存写入 + 输出；缓存命中率 = 缓存读取 / 全部输入。缺失完整 usage 不猜测用量；完全没有缓存用量信息时隐藏命中率。OpenAI 的 completion_tokens/output_tokens 与 Anthropic output_tokens 已包含思考 token，reasoning_tokens/thinking_tokens 不再次相加。用量或有效时界缺失时不显示速度，不以字符数/块数代替 token；过期的流式部分用量不能当作完整输出。模型性能由 AI 层 MeasuredAssistantStream 和会话层 SessionPerformance 采集，渲染层只格式化与展示。旧任务/分叉首次打开时从已有历史回填轮数、步数和已报告用量，逐条读取，不保留完整上下文；旧版本未保存的时延无法追溯补算。

辅助对话保留继承上下文，但不显示继承时间线。创建时，继承统计与历史复制使用同一父快照和截止边界，保存统计基线后只累计辅助对话自己的新请求；主任务仍在运行时，不直接复制其最新实时总量。旧辅助对话只在原始继承前缀可核实时修正多算的轮数，并保留步数、用量及已记录耗时；无法可靠恢复时省略轮数，不显示猜测值或零。重启和累计统计重建须保持这一行为。

辅助对话打开时立即平滑展开侧栏，不显示创建中的文字提示；保留内部加载状态，草稿与快照就绪后才允许编辑，命令和 Skill 建议后台加载。侧栏仅在显式打开或关闭时执行平滑宽度与透明度过渡，动画期间固定内部内容宽度；拖拽调整和窗口尺寸变化保持即时响应，并尊重减少动态效果的系统偏好。可见历史默认按最近十次模型调用分页（不是十轮用户交互），另有约 2 MiB 软限制；分页不会读取辅助对话隐藏的继承前缀。向上加载会累计可见页，不等同于虚拟列表。

辅助对话复制、分叉和回退所需的新历史 generation 使用批量导入：单文件句柄顺序写入，有界逐条校验及索引构建，整批文件同步与索引提交完成后才发布新 generation。普通运行时追加仍逐条持久化。固定记录 schema 仅编译一次并复用，所有原有校验继续执行；继承统计在同一遍历史读取中累计。创建性能应测量创建至输入可用的总路径，不能只以快照加载耗时或 fsync 次数作为验收；故障测试需覆盖写入、校验、索引、同步与发布边界，并确认旧历史仍可恢复。

定向验证：

```sh
npm run test:unit -- packages/ai/test/model-performance.test.ts packages/ai/test/provider-performance.test.ts packages/coding-agent/test/model-performance.test.ts packages/coding-agent/test/session-performance.test.ts packages/desktop/test/model-performance.test.ts
npm run test:desktop -- tests/desktop/model-performance.spec.ts
```

### 单元与服务测试：不启动窗口

`npm run test:unit` 只运行 `packages/*/test/**/*.test.ts`，使用 Node 环境，不启动 Electron、浏览器或桌面窗口。部分用例会启动本地假模型 HTTP 服务、Git 或 Shell 子进程，并使用临时目录；它们不是纯函数测试，但不需要 GUI。

每个测试文件在独立的临时 HOME、配置与缓存目录、系统临时目录中运行，并清除继承的 Shell 启动脚本变量；测试环境在所有清理钩子结束后移除这些目录，避免读取用户配置或清理真实会话的临时日志。

先运行与改动相关的文件，再跑完整套件：

```sh
npm run test:unit -- packages/desktop/test/side-chat.test.ts
npm run test:unit -- packages/coding-agent/test/context-usage.test.ts
npm run test:unit
```

默认最多使用 50% 的可用测试 worker，给本机其他工作留出 CPU 余量，并保留测试文件间隔离。专用测试环境可运行 `npm run test:unit -- --maxWorkers=100%` 使用更多 worker；实际耗时取决于 CPU、内存和其他负载，不保证增加并发就更快。

新增测试优先验证公开行为、失败路径和并发边界；同类输入用参数化用例覆盖，避免在多个层次重复相同断言。需要真实 renderer/preload/main 交互时再增加桌面测试，不以测试数量代替覆盖价值。

### 默认桌面集成测试：后台运行真实 Electron

`npm run test:desktop` 先做静态安全检查、构建，再运行 Playwright；默认单 worker。renderer、preload、IPC、原生浏览器视图和 PTY 仍是真的，支持页面内输入、截图和失败 trace。隐藏窗口仍需要图形环境；Linux 无桌面环境需要虚拟显示服务。

所有桌面用例从 `tests/helpers/test.ts` 导入 `test`，使用 `tests/helpers/desktop.ts` 的 `launchDesktop`。自动 fixture 在任何测试代码执行前创建独立临时作用域，包含测试数据、Home、Chromium profile、Shell 配置和临时文件；启动器只继承必要的系统环境，不继承模型密钥、代理、开发 URL 或数据目录覆盖。测试目录必须在当前作用域内。

`packages/desktop/src/main/automation.ts` 在应用服务和窗口启动前安装隔离，窗口统一通过 `createDesktopWindow` 创建。默认窗口隐藏、不可聚焦、无任务栏入口；显示、激活、恢复、全屏、闪烁、DevTools、原生对话框/菜单、外部应用打开和全局快捷键注册被拦截。macOS 测试只修改临时复制的应用包，加入 `LSUIElement` 并采用 `prohibited` 激活策略。**隐藏窗口也不能调用 `setEnabled(false)`**：它在 macOS 上会创建可见的原生覆盖窗口，退出流程已避开该调用。

文本剪贴板在主进程内存中保存，其他格式默认拒绝；preload 取消可信剪贴板事件的 Chromium 默认动作，权限请求被拒绝。测试粘贴必须构造带 `DataTransfer` 的 `ClipboardEvent`，不能发送系统粘贴组合键。页面内 `keyboard`、`mouse`、DOM focus 和限定目标的 `sendInputEvent` 可以验证 renderer 行为，不操作系统鼠标位置。通知仍经过真实业务逻辑和 IPC，只拦截系统展示并静音。需要验证外部打开/对话框时，为该用例提供明确的假边界；不要启动用户的编辑器或浏览器。

自动 fixture 在正常、断言失败和超时后关闭所有启动过的 Electron。独立 guardian 观察测试 worker 的后代进程；取消或 worker 崩溃导致管道关闭时，清理仍会执行。它按 PID 和启动时间核对身份，只终止观察到的测试后代，不按应用名杀进程；最后删除本作用域。测试仍应使用 `runCleanup` 及时关闭本地服务。该机制不是进程权限沙箱；宿主/guardian 同时被强杀、系统断电、未观察到的瞬时脱离进程不在可保证的清理范围内。

定向运行与重复验证：

```sh
npm run test:desktop -- tests/desktop/hidden-window.spec.ts tests/desktop/side-chat.spec.ts
npm run test:desktop -- tests/desktop/hidden-window.spec.ts --repeat-each=2
npm run test:cleanup
npm run test:safety
```

`test:cleanup` 启动独立的真实 Playwright 子套件，验证正常、断言失败、超时、SIGINT 取消和 worker 被终止后的清理；子套件的预期失败不会被伪装成业务测试通过。结果输出明确列出预期退出码、Electron 退出和临时目录删除。另有 Node 层回归验证脱离进程组的后代清理及无关进程保持存活。

macOS 可选用只读系统观察器验证应用进程是否真的出现在屏幕或前台；需要 Xcode Command Line Tools。它构建后运行同一后台入口，每 50 ms 读取窗口归属/边界、前台 PID 和剪贴板变更计数，不截屏、不读取窗口标题或剪贴板内容，也不注入输入：

```sh
node scripts/observe-desktop-tests.mjs tests/desktop/hidden-window.spec.ts --repeat-each=2
node scripts/observe-desktop-tests.mjs --cleanup
```

测试窗口可见或成为前台会令观察入口失败。JSONL 和汇总 JSON 作为验证输出保留在打印的临时目录，观察器二进制及进程自动清理。剪贴板计数变化可能来自用户日常操作，不能直接归因于测试；采样也不能证明采样间隔内绝无瞬时行为。运行不同桌面套件时应串行，避免它们同时重建共享的 `dist`。本轮实际结果和未通过项见 [桌面隔离验收记录](evidence/desktop-test-isolation.md)。

直接运行 `npx playwright test` 或 `npx vitest run` 也会执行安全检查。检查会拒绝绕过统一启动器、从原始 Playwright 导入测试 fixture、直接创建窗口、使用原生剪贴板快捷键和已知系统输入工具。运行时拦截会记录违规，即使业务代码捕获异常，测试关闭时仍报错。开发启动脚本拒绝在测试环境中启动；独立截图对比脚本 `scripts/verify-preview-sidebar.mjs` 也复用统一启动器及作用域。静态检查用于发现常见回归，并非对任意脚本行为的安全证明。

### 显式交互验证：会显示窗口并改变焦点

默认配置不包含 `tests/interactive/`。旧的 `ZPI_TEST_SHOW_WINDOW=1` 不再允许改变默认套件，默认配置会明确报错。npm 后台入口在加载 Playwright 前拒绝 `PWDEBUG`、`--debug`、`--ui`、`--headed` 和配置替换，并禁止 HTML 报告自动打开浏览器。直接调用 Playwright 的 `--ui` / `show-report` / `show-trace` 本身就是打开界面的命令（UI 模式可能忽略配置加载错误），不属于后台入口，不应在办公时使用。需要真人桌面验证时，应先获得当前使用者同意，再执行：

```sh
npm run test:interactive
# 仅列出用例，不打开窗口
npx playwright test --config=playwright.interactive.config.ts --list
```

交互用例包括 `tests/interactive/window-focus.spec.ts`（真实主窗口隐藏后的激活、显示和焦点）及 `tests/interactive/quick-chat-focus.spec.ts`（快速浮窗取焦点、Esc 隐藏与草稿恢复）。这些用例继续隔离数据、剪贴板、通知及外部应用，也不向操作系统注册全局快捷键。普通套件中的快捷键、浏览器/终端焦点、通知点击和文件打开仍保留真实 Electron/IPC 覆盖，只有系统边界使用假实现。

真实全局快捷键占用、macOS 前后台切换、真实系统通知/文件选择器、跨应用剪贴板及真实编辑器唤起目前属于人工系统集成烟测，未被默认测试验证。不要为了这些检查临时去掉后台保护；需经同意在专门的桌面环境验证，不能将模拟注册记作系统注册成功。

### 打包测试：同样后台隔离

完整桌面套件仍包含 `history.spec.ts` 和 `terminal.spec.ts` 的打包用例，需要已有 macOS `.app`。只运行 `npm run build` 不会产生应用包。可先执行 `npm run package:mac`，或只生成目录包：

```sh
npm run build
npx electron-builder --mac dir
ZPI_TEST_PACKAGED_APP="$PWD/release/mac-arm64/ZPI.app" npm run test:desktop -- tests/desktop/history.spec.ts tests/desktop/terminal.spec.ts
```

启动前会检查应用包是否包含当前版本的隔离机制；旧包明确失败，不执行它。测试将包复制到临时数据目录后运行，验证不依赖仓库中的依赖。未运行的 macOS 打包用例不能记作其他平台通过。

`docs/specs/` 和 `docs/evidence/` 保留实现时的设计、引用版本和验收记录。其中的测试数量、机器路径及当时未运行的检查只描述该次工作，不是当前覆盖率、当前工作树状态或后续改动的测试豁免。

### 存储专项验证

SQLite 状态、独立迁移、历史换代、编辑恢复与辅助对话回归的命令见 [存储专项指南](specs/sqlite-storage.md#定向验证)。大样本脚本只生成临时合成数据；按需恢复的实测环境和限制见 [基准报告](storage-lazy-restore-benchmark.md)。迁移验证逐条对照源转换结果，因此 validate/activate 需要保留未变化的离线旧源。

实际 Electron 二进制的 Node 模式 SQLite 烟测通过不等于 Electron GUI/打包通过。构建必须保留 `node:sqlite` 前缀；主进程/preload 的 tsup 配置已禁用移除 Node 协议，专门的 `sqlite-build.test.ts` 防止再次回归。

## 快捷键实现与回归

桌面快捷键定义和解析集中在 `packages/desktop/src/shared/shortcuts.ts`，设置保存在 SQLite 的 `app_settings`（`app` 配置的 `shortcuts` 字段）。平台默认值使用明确的 Command/Ctrl 映射；新建配置采用默认值；旧格式设置由独立迁移工具转换。默认左栏 [、右栏 ]、本地环境 J、任务搜索 K、模型选择 L、任务输入框聚焦 I、已有任务顶部菜单 U，均使用平台主修饰键。离线迁移中的 `shortcutDefaultsVersion` 标记一次性迁移：按历史版本仅替换仍为旧默认的绑定，保留自定义、清空项和总开关；整个候选存在冲突时保留全部旧绑定。旧记录缺少输入框聚焦命令时补 I，若 I 已被自定义占用则补空绑定。新增本地环境命令默认 J，被自定义组合占用时补空绑定。迁移版本与结果原子保存，后续主动改回旧组合不会再次迁移。当前 SQLite 配置缺少任务菜单命令时，读取阶段补 U；已被自定义组合占用则补空绑定，下一次主动保存时持久化。全局窗口键由主进程负责注册，应用命令只在应用窗口内处理，浏览器 WebContentsView 转发侧栏、置顶、新建、任务搜索、查找、任务菜单和显式输入框聚焦命令，xterm 焦点由 renderer 捕获阶段处理。本地环境、模型选择和队列发送由当前 composer 自己处理。

全局改键先注册候选键，再保存设置并注销旧键；注册或保存失败不会覆盖原设置。退出只有在草稿确认保存后才注销，取消退出仍保留原绑定。`ZPI_TEST_MODE=1` 从不向系统注册全局快捷键，注册冲突、回滚及窗口切换使用假 registry/window 单元测试。

当前 composer 的 `⌘Enter` / `Ctrl+Enter` 优先直接发送草稿，先校验输入，再中止当前回复；原有队列保留，在本次回复完成后继续。空草稿仍发送队首，普通 Enter 在运行中仍排队。通过现有 `submitInput` IPC 的 `immediate` 参数进入同一会话串行队列，主/辅助对话共用，不修改 SDK 或核心工具。

定向回归用例在 `tests/desktop/shortcuts.spec.ts`、`tests/desktop/shortcut-settings-parity.spec.ts`、`tests/desktop/composer-shortcuts.spec.ts` 与 `tests/desktop/composer-menus.spec.ts`，涵盖搜索与录入、持久化、总开关、冲突及错误反馈、浮层重复按键切换、任务菜单键盘导航、侧栏/置顶、原生浏览器与终端焦点，以及主/辅助 composer 的发送、队列和模型操作。真实系统全局抢占与 macOS 前后台切换仍需在目标平台做手工烟测；不可将测试模式的模拟注册视为系统注册成功。

## 旧版历史会话修复（仅旧格式）

以下命令只用于尚未迁移的旧数据副本，不是 SQLite 迁移命令。不要对 `storage/<generationId>` 运行它，也不要据此删除新数据库。新格式迁移使用 [独立迁移 CLI](specs/sqlite-storage.md#独立迁移-cli)。

先退出 ZPI、ZPI Preview 和开发客户端，再运行：

```sh
npm run repair:sessions -- --dry-run
npm run repair:sessions
# 指定包含 agent/sessions 的应用数据目录，而不是项目目录：
npm run repair:sessions -- "/path/to/app-data"
```

默认检查正式版与 Preview 的应用数据目录。脚本将旧会话格式、内部记录和系统段落键改为小写 `zpi`，按默认值补齐缺失的能力配置，保留已有配置和消息正文。

修改前在数据目录旁备份原始会话与旧索引，修改后移除旧索引，旧版应用重启时重建；本分支仍要求独立迁移。已修复数据重复运行不会写入或新建备份。此命令、`scripts/repair-sessions.ts` 及其测试仅短期保留，迁移完成后可一并删除。

## 命名约定

产品展示和自然语言文案使用 **ZPI**；npm 包、隐藏目录（`.zpi`）、应用 ID、IPC、存储键和前端技术前缀使用小写 `zpi`；环境变量和全大写常量使用 `ZPI_*`。

应用显示名及其对应的 `ZPI.app`、`ZPI Preview` 数据目录保留品牌大小写。OpenAI 对接是明确例外：ChatGPT 授权参数 `agent_name_hint` 和 Responses 工具命名空间保留大写 `ZPI`，不要随内部技术命名修改。

### 文件与变更预览

新标签页中的「审查」使用独立的 Git 审查面板，来源按「未暂存 / 已暂存 / 全部分支更改 / 上一轮更改」排列，默认未暂存。文件初始折叠，逐个展开统一 Diff；右键可复制路径、系统定位或在文件树显示。分支来源比较上游 merge-base 与 HEAD；上一轮使用会话最新轮次的已有快照，不回退到任务累计变更。任务查找在已打开的审查页搜索当前来源，其余情况下继续打开任务累计变更。详见 [审查合同](specs/git-review.md)。

普通修改通过完整 before/after 使用 MultiFileDiff，显示并真实展开首部、中间、尾部的 `unmodified lines`；局部 patch、大文件及特殊格式按参考的相同规则降级。审查默认采用 GitHub 深浅高亮、12px、WASM 和共享 diff worker 池，界面设置可调整代码主题和字号。Vite worker 插件显式保留依赖的 worker 入口副作用，防止打包后被 tree shaking 变成空文件。`tests/desktop/git-review.spec.ts` 使用三个相隔修改点的 Java 文件验证 `14 / 13 / 13` 折叠区、真实正文展开及主题切换。`review-shell.spec.ts` 验证标签恢复、完整视图、草稿和 Diff 状态保留及快捷键。

右侧栏完整视图保留左栏当前状态，左栏仍可独立开合、调整宽度。对话和浮窗均以右侧面板的实际内容区定位。浮窗复用同一个 composer 和草稿，采用 ZCode 的单行布局：空白或单行时高 46px、8px 内边距、28px 加号与发送按钮，不展示项目栏和模型工具栏；多行和附件按内容增长。收起态仅在浮窗内有焦点、操作菜单打开或拖动时显示上方 40px 操作栏，展开态始终显示；悬停输入框或按钮不触发抽屉开合。悬浮发送、排队和停止按钮不显示文字提示，加号保留提示及菜单，避免提示浮层与上栏相互触发。展开消息、最小化和拖动吸附仍保留。`review-shell.spec.ts` 同时验证左栏开合与拖宽、窄窗口、多行输入、按钮提示与抽屉稳定性和深浅主题截图。

可选的 `tests/desktop/review-reference.spec.ts` 在隔离 Electron 中编译并对比两套真实审查组件，使用相同 Java 快照和固定视口。以 `ZPI_ZCODE_REFERENCE=/absolute/path/to/ZCode node scripts/test-desktop.ts tests/desktop/review-reference.spec.ts` 运行；未设置参考路径时跳过。参考仓库需已安装依赖，不参与产品构建。截图和像素统计保存在测试输出目录，可用 `ZPI_REVIEW_EVIDENCE_DIR` 指定独立输出位置。逐像素检查覆盖折叠深浅主题、来源菜单和展开滚动后的代码区域；置顶标题采用不透明背景以避免代码透出，允许与参考的模糊透底区域不同。

定向验证：`npm run test:unit -- packages/desktop/test/git-review.test.ts packages/desktop/test/review-pane-dom.test.ts`；桌面集成验证：`npm run test:desktop -- tests/desktop/git-review.spec.ts`，覆盖菜单、展开、刷新、快照、右键树定位、跨文件查找及 160 文件虚拟列表。

回答的围栏、缩进和 HTML 代码块不产生文件预览卡片。内联代码中的 citation 与 Markdown 链接示例也不解析；反引号包裹的纯文件路径（如 `report.pdf` 或 `file:///workspace/report.pdf`）仍是有效交付引用。文件存在性及 MD/HTML 的本轮变更校验继续适用。

文件预览使用共享路径面包屑与右上操作。三点菜单中的路径复制经现有主进程文件操作完成；纯代码显示自动换行，Markdown/SVG 先提供预览/源码选择，源码模式才显示换行。Diff 默认统一视图，Tab 标记 `Diff`，提供“查看源码”，不提供备注或换行选项。从聊天变更摘要点击文件，只加载进该路径的变更条目，搜索也限定该文件；同轮不同文件使用独立 Tab，重复打开相同来源复用。工具卡片预览保留本次操作补丁，与整轮累计变更分离。单文件不显示兄弟文件列表或旧“统一/并排”工具条；无路径的全部变更入口仍提供完整文件列表与跨文件搜索。

源码查看器的行备注数据与渲染回调保持稳定，避免按住 ⌘/Ctrl 显示置顶快捷键提示时重建正文并清空原生文字选区。

文本左侧的 `+` 和行号拖选创建单行或多行备注。备注可以不填，但所选代码不能全为空白。添加只写入对应任务（包括辅助对话）的现有输入草稿引用，发送时才随消息带上路径、行号、代码和备注；不会写入原文件，也不会自动发送。Esc 取消，⌘/Ctrl+Enter 添加，输入法组合期间不触发提交。预览中删除和输入框移除引用保持同步，沿用引用数量/长度限制，错误保留编辑内容。大文本关闭语法高亮但仍提供行备注；原主进程 2 MiB 文本读取上限保留并明确提示。

Markdown/SVG 默认预览，`.mermaid/.mmd` 使用现有 Mermaid 图表渲染；普通 `.txt/.text` 及未知文本使用参考的 log 高亮，识别脚本 shebang 和 diff 内容。HTML 作为代码显示，不在有权限的页面运行。图片使用棋盘背景并识别 `@2x`/`@3x` 像素倍率；音视频使用居中原生只读播放控件。工作区编辑器入口使用已安装程序白名单和独立安全 IPC；文件与 Diff 预览右上按钮通过现有文件操作 IPC 使用系统默认程序打开，不受工作区编辑器偏好影响。显式工作区下拉选择才修改编辑器偏好。

工作区右上编辑器入口复用 ZCode 对齐的 `parity-menu` 样式：28px 图标按钮与 20px 下拉按钮分段；菜单宽 160px、内边距 4px、选项间隔 2px，应用图标和名称左对齐、16px 选中勾在最右侧。不要复用 `selection-menu` / `menu-item`，它们的 180px 最小宽和两端对齐会覆盖此布局。展开态只高亮下拉半边，菜单沿用键盘导航、Esc/外点关闭与焦点恢复；选择应用仍保存偏好并打开当前工作区，预览按钮独立使用系统默认程序。

`npm run test:unit -- packages/desktop/test/workspace-editor-dom.test.ts` 以真实 React/Radix DOM 事件覆盖分段触发、选中标记、工作区打开参数、预览默认程序打开与工作区偏好隔离、重复展开、键盘选择、关闭、异步发现与错误日志；不启动外部编辑器。DOM 测试不证明原生 macOS 图标渲染或像素布局。

Office/PDF/PPTX 均使用本地只读渲染：Word `.docx` 使用 docx-preview 保留页面/页眉页脚并按面板收缩，旧 `.doc` 使用 react-docx；Excel `.xlsx/.xlsm/.xls` 提供工作表切换。PDF 使用 react-pdf/PDF.js，本地打包 worker、CMap 与标准字体；大于 2 MiB 通过受限 IPC 分段读取，不向外部站点上传。PPTX 使用本地 pptx-renderer，提供缩略图、页码、缩放、元素上下文及导出 PDF；导出仅写用户在保存对话框选择的目标。旧 `.ppt` 与参考同样不支持。

定向逻辑测试：

```sh
npm run test:unit -- packages/desktop/test/file-comments.test.ts packages/ui/test/diff-view.test.ts packages/desktop/test/file-actions.test.ts
```

桌面验证仍须使用上述隔离启动器；无 Electron/虚拟显示或浏览器沙箱不可用时，不把 SSR/单元测试当作视觉验证。所有外部程序启动、剪贴板和对话框测试必须使用假服务，不能操作真实系统程序或用户剪贴板。


## 模型图片请求预算

内置 `read` 的图片输入最多 20 MiB，已知超限文件在读取正文前拒绝。图片处理使用 Sharp 执行沿用自 ZCode 的候选阶梯，同时校验 raw ≤ 3,932,160 字节、base64 ≤ 5,242,880 字节、图片 token ≤ 25,000（base64 字符比例 0.125）。最紧约束派生出 base64 ≤ **200,000 字节**、raw ≤ **150,000 字节**，与模型输出上限独立。模型级 resize 覆盖只能收紧这些约束。WebP 只按字节/token 预算直通，不解码、不检查尺寸，超限返回 `unsupported`。

用户附件有意不传图片 token 预算，因此允许到 5 MiB base64，约为 Read 的 26 倍；导入仍保留单张 10 MiB 与像素校验。尺寸和预算内的原图原字节保留，包括元数据、EXIF 和 GIF 动画；需要转换的 GIF 只保留首帧。PNG 仅有一次原尺寸无损优化机会，随后转 JPEG；透明图转 JPEG 为黑底。JPEG 质量可降到 20，兜底最长边可降至 200px，截图小字、按钮、布局细节可能无法辨认；压缩成功不代表内容可读。

图片校验、解码、缩放和编码统一使用 Sharp；BMP 保留已有 `bmp-js` 与格式守卫适配，将像素交给 Sharp。非 WebP 每次处理完整解码并校正首帧方向，再复用同一份原尺寸像素生成候选，不再经过第二套解码器或为每个候选复制 JS 位图。JPEG 同尺寸质量尝试复用已缩放、黑底合成的像素，只保留当前尺寸，不缓存整条阶梯的位图。Jimp 及其专用依赖、打包配置已移除；Sharp 继续作为 native external 分发。解码后的原尺寸像素仍受 4000 万像素上限约束，另有当前 JPEG 候选像素的临时内存成本。

压缩候选顺序保持不变：JPEG 质量 80/60/40/20，基于受尺寸限制候选的非累积缩放 0.75/0.5/0.25，以及基于原图的 1000/800/600/400/300/200px JPEG quality 20 兜底；JPEG/GIF/BMP 的保格式尝试仍在原位置。PNG 只有一次原尺寸无损尝试，使用 Sharp 的 compressionLevel 9 与 adaptiveFiltering；不同编码器的质量数值、压缩结果和像素重采样结果不要求与上游逐字节一致，每个候选都须通过原有预算检查，命中后立即停止。WebP 的预算内原字节直通、超限 `unsupported` 规则保持不变，与 Sharp 本身支持转码的能力独立。

SDK 的 `autoResizeImages: false` 禁止缩放和压缩，尺寸或字节预算超限则返回 `too_large`；BMP 允许必要的同尺寸 PNG 格式转换，转换结果也须满足预算。WebP 保持上述独立直通规则。导入动画提示仅说明压缩转换会保留首帧；预算内原图不再被误报为已拍平。

所有 provider 请求先做模型能力投影，再做 40 MiB 聚合媒体预算。主会话、侧边会话、子代理、快速对话和标题请求经 `ModelRuntime`；摘要及直接协议调用也执行同一媒体策略。只计媒体 data URL 的 UTF-8 字节（包含前缀），不计正文、工具和 JSON，因此 **40 MiB 不能保证 HTTP body 上限**。当前真实用户附件受到保护，单独超限则在调用 provider 前拒绝；工具结果没有当前轮保护。只改请求副本，原历史和附件缓存保留。省略事件通过可选通用 `onMediaProjection(stats, context)` 钩子报告，未注入时不输出日志。桌面主会话、侧边会话、子代理、标题及快速对话将其写入 `agent/logs/error.log`，附带原始 `sessionId`（摘要缓存路由 ID 独立）。字段为 `omittedMediaCount`、`projectedMediaBytes`、`retainedMediaCount`、`totalMediaBytes`、`evictionFrontier`，前沿保留结构化 messageIndex/blockIndex；不记录图片数据。

相对 ZCode 唯一批准的淘选差异是历史扫描遇到放不下的媒体时 `break`，保留连续的最新后缀；被大图挡住的小图也会丢弃。等尺寸截图批次与上游 `continue` 结果相同。追加历史且保护集不变时不会复活旧图；新用户轮次改变保护集后无此单调保证。此策略提供可预测性，不宣称提高缓存命中率。每次从原历史重算，无低水位、滞回、空闲门控或最小收益门槛；靠前图片被省略会让该点之后的缓存前缀失效。单图小预算降低聚合裁剪频率，不解决 KV cache 问题。

Anthropic 缓存保持 stable 内容、dynamic sections 各自的 system 断点和最新非 system 尾断点；构造请求时校验 system、工具和消息内容上的 `cache_control` 总数不超过 4（不扫描用户工具入参）；`skipCacheWrite` 将尾断点前移，system 标记保留。标记经 Anthropic Messages 协议传输，适用于使用该协议的 DeepSeek 配置；不按模型品牌忽略标记。

`compaction.microcompact.enabled` 默认关闭，显式开启后，在空闲超过 60 分钟或本地 token 估算达阈值时只清理白名单中的旧纯文本工具结果，保留最近 5 组助手工具调用（`keepRecentToolResults` 按组计数）；有 image/video/file 的结果全部跳过。节省少于 256 token 则整体回滚。`microcompact` transcript boundary 记录 trigger、strategy、前后估算与 tool call IDs，恢复时投影工具结果，不覆盖原始记录。SDK 在写入 boundary 时清空文件读取去重状态，避免再次读取只返回指向已清除正文的“文件未变化”存根。默认阈值为 `min(floor(autoCompactThreshold × 0.9), autoCompactThreshold - 2000)`，复用 ZPI 的上下文预留设置。

本地图片 token 估算使用短占位，不反映实际图片体积；Read 的 0.125 比例也是本地预算换算，不是供应商的视觉 token 或像素上限保证。已有 provider usage 锚点仍会参与自动压缩，所以 token 压缩不能替代字节预算。裸 `413 Failed to buffer the request body: length limit exceeded` 不扩展为上下文或媒体错误，不自动恢复，UI 提示压缩对话或开启新会话。摘要仅在明确识别的媒体过大错误上去媒体重试，明确上下文溢出时有界截断重试；未知错误不做此降级。去媒体重试是通用摘要接口的防御措施，当前内置摘要序列化通常已是纯文本。

聚焦回归：`npx vitest run packages/coding-agent/test/read-image-budget.test.ts packages/coding-agent/test/media-request-session.test.ts packages/ai/test/media-policy.test.ts packages/coding-agent/test/microcompact.test.ts`。42 张临时生成图片经真实 session/read 工具、43 次本地测试 provider 请求验证，并额外加入超预算旧图片历史；不依赖真实凭据，也不代表已经通过供应商线上网关验收。ZPI 目前没有独立记忆代理、内置 PDF 页面提取或 MCP 图片入口，本次不引入这些能力。


请求入口核对：

| 入口 | 当前调用链与策略接入 |
| --- | --- |
| 主会话 / SDK | `session-host.ts` / `sdk.ts` → `AgentSession.measuredStream` → `ModelRuntime.streamSimple` |
| 侧边会话 | `SessionHost.createSideChat` → 同一会话创建与模型运行时 |
| 子代理 | `plugins/subagents/runtime.ts` → `SessionHost.createSubagentSession` → 同一模型运行时 |
| 快速对话 | `quick-chat-host.ts` → `createAgentSession` → 同一模型运行时 |
| 标题 | `session-title.ts` → `ModelRuntime.streamSimple` |
| 对话 / 回合摘要 | `compaction.ts:completeSummarization`（包括注入 stream 和直接调用）→ 共同媒体策略 |
| AI 协议公开接口 | `stream.ts` 负责路由；三个 `api` 请求入口执行共同媒体策略，自定义 provider 在 `ModelRuntime` 边界执行 |
| 记忆代理 | 当前仓库不存在独立实现；未新增 provider 旁路 |

原生 provider 的媒体策略只在协议请求入口计算，共用 stream 包装层和普通 `ModelRuntime` 调用不再重复投影。摘要注入 stream 可能绕过协议，因此保留防御性投影并传递同一 observer；下游已投影请求无新增省略，不重复上报。显式最新用户索引仅在整数且 `-1 ≤ index < messages.length` 时采用，非法值回退到真实用户判定。image/video 必须有内联 `data` 或 `dataUrl`；缺失时返回 `MEDIA_PAYLOAD_MISSING`，未来 URI 图片须显式接入请求策略，不能按零字节静默绕过。

媒体字节计算在共享 AI 层直接统计 UTF-8 长度，不依赖 Node `Buffer`，也不拼接完整 data URL 或创建编码副本；投影复用已统计的位置。compact 重试同时识别 `data`/`dataUrl` 形式的无提取文本文件，含提取文本的文件保持原样。
