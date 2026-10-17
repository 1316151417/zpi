# ZPI 项目深度 Bug 检查报告

> 审查对象:ZPI 桌面客户端(monorepo,`packages/{ai,agent,coding-agent,desktop,ui}`),版本 0.2.96(commit `688b8e8`)。
> 审查范围:近期大量迭代(0.2.36 → 0.2.96)新增的功能:quick chat 窗口、DeepSeek web 搜索/抓取扩展、自定义命令与 slash 菜单、命令导入、浏览器/终端面板、SQLite 状态存储、任务分组、自定义快捷键、模型性能统计、辅助对话等。

## 方法与基线

- 跑通 `npm run check`(tsc 通过;Biome 仅 4 条样式警告)与 `npm run test:unit`。
- 由 6 个并行子代理逐行审查各功能模块,关键发现均经独立核验(亲自复现或代码级确认)。
- 单元测试基线:**3004 通过 / 3 失败 / 23 跳过**——3 个失败用例本身就是 3 个真实 bug 的直接证据。
- 审查日期:2026-10-18。

---

## 一、现有测试已直接证实的 Bug

跑 `npm run test:unit` 即可复现以下三个问题。

### 1.【中】macOS 上 22 个凭据安全测试全部静默跳过

- 位置:`packages/desktop/src/main/index.ts:216`
- 证据:`process.getSystemVersion()` 是 Electron 专属 API,但代码在 `process.platform === "darwin"` 时无条件调用。单元测试在纯 Node 下 import 真实 `main/index.ts`,直接抛出:

  ```
  ZPI 启动失败 TypeError: process.getSystemVersion is not a function
  ```

  `web-credentials-ipc.test.ts` 整文件失败、22 个用例全部 skip。
- 影响:macOS 开发机上凭据 IPC 的所有安全回归测试(非 owner 窗口拒绝、密钥不落 IPC 日志、locked-credential 行为、quick chat 通道隔离等)从未执行过;Linux CI 因 `&&` 短路而"全绿",掩盖了问题。生产环境(Electron 主进程提供该 API)不受影响,属测试基建 + 可移植性缺陷。
- 复现:`npm run test:unit -- packages/desktop/test/web-credentials-ipc.test.ts`
- 修复方向:`process.getSystemVersion?.()` 加守卫与回退,或在测试 fixture 中 stub 该 API。

### 2.【中】自定义命令扫描上限逻辑错误,且结果依赖文件系统枚举顺序

- 位置:`packages/desktop/src/main/custom-commands.ts:485-543`(`list()` 的 `visit()`)
- 证据:
  - 触达 `maxEntries` 后置 `exhausted = true` 并 break,但仍**继续处理已收集的条目**;外层循环也不检查 `exhausted`,只有递归新子目录被拦截(第 523 行 `else if (!exhausted)`)。
  - 收集到哪些条目取决于 opendir 的原始顺序(APFS 上非字母序)。实测 `maxEntries:2`、文件 `a.md/b.md/c.md` 时返回 `[b.md, c.md]`——`a.md` 被丢弃纯粹因为 opendir 先吐出 `b.md`。
  - 实测 `maxEntries:3`(`z.md` + `nested/{n1,n2}.md`):耗尽发生在枚举 `nested/` 时,结果仍包含其后读取的 `z.md`。
  - 测试 `custom-commands.test.ts:513` 期望 `commands: []` 实得 `[b.md]`,失败。该测试自 0.2.75 起未变,是实现偏离了意图(0.2.75 的模块重放结果相同,属存量问题而非回归)。
- 影响:超限后返回不完整且不确定的命令列表;也解释了为何提交信息能声称"2042 unit tests passed"——不同机器的 readdir 顺序不同。
- 修复方向:条目上限触达后中止整个扫描并返回空列表(即测试断言的行为);至少应丢弃被截断目录已收集的条目。

### 3.【中】命令导入在 macOS/Windows 上把"同名已存在"误报为"文件已存在"

- 位置:`packages/desktop/src/main/command-import.ts:220-229`(`conflict()`)
- 证据:`lstat(join(this.target, path))` 探测先于大小写不敏感的 `names` 检查。大小写不敏感文件系统(macOS APFS 默认、Windows NTFS)上 `lstat("REVIEW.md")` 会命中刚导入的 `review.md`,永远走不到 `sameNameExists` 分支。测试 `command-import.test.ts:210` 期望 `[undefined, "sameNameExists", "targetExists"]` 实得 `[undefined, "targetExists", "targetExists"]`。Linux(大小写敏感)上 `lstat` 得 ENOENT,`names` 检查生效,因此 CI 通过。
- 影响:`CommandImportDialog.tsx:55` 将两种原因渲染为不同文案("同名已存在" vs "文件已存在"),macOS/Windows 用户在 `discover()` 与 `importSelected()` 两个阶段看到的冲突原因都是错的。功能上仍会跳过,不会覆盖文件。
- 修复方向:大小写不敏感 FS 上 `lstat` 无法区分精确匹配与大小写变体,需要用目标目录扫描得到的精确文件名集合来判断。

---

## 二、独立复现的 Bug

### 4.【中】编辑消息重启窗口的竞态:已被接受的"恢复消息"复活成幽灵队列项

- 位置:
  - `packages/desktop/src/main/input-queue.ts:65,91` —— `submit()` 在 `await runtime.prepare()` **之前**快照队列(`const queue = this.get(id)`),之后用该旧快照提交(`this.commit(id, { ...queue, items: [...queue.items, item] })`)。
  - `packages/desktop/src/main/session-host.ts:2270-2281` —— 0.2.64 的 finally 修复块调用 `this.inputQueue.restore(id, queue)`,而 `restore()` 是普通方法,**绕过了 `serial()` 串行链**。
- 复现(基于真实 `SessionInputQueue` 类的独立脚本,已运行成功):

  ```
  queue before concurrent submit: {"items":[{"id":"recovery-1","text":"replacement",...}],"autoDrain":false,...}
  queue after fix-restore (should be clean): {"items":[],"autoDrain":true,...}
  final in-memory queue: {"items":[{"id":"recovery-1",...},{"text":"concurrent",...}],"autoDrain":false,...}
  GHOST RECOVERY ITEM PRESENT: bug reproduced
  ```

- 场景:用户编辑最新消息(运行中止 → 重写历史 → 重启替换运行,`preserveEditedInput` 先把替换文本放入队列作为恢复项),在 `startRun` 的异步窗口内(通常几十到几百毫秒)又发送了一条新消息。竞态的 submit 持有含恢复项的旧快照,在 finally 清理之后提交,把已被接受并正在流式输出的替换文本重新写回"待发送"队列。
- 后果:
  - 渲染层显示幽灵队列项;点"立即"会先 `runtime.stop` 中止当前运行,再把同一文本重发一遍(重复轮次)。
  - 内存态与磁盘态分叉(持久层 `setQueue` 会过滤已接受项,`state-store.ts:510-526`),只有重启应用才自愈。
  - 同样的旧快照模式也影响与 `move`/`remove` 的竞态。
- 修复方向:`submit()` 在 `await prepare` 之后重新读取 `this.get(id)` 再提交;或让 finally 的 `restore` 走队列的串行链。

---

## 三、代码级验证的 Bug(附 file:line 证据与复现步骤)

### 5.【中高】macOS 生产构建下 Cmd+R 重载渲染进程:浏览器视图遮挡 UI、终端进程泄漏

- 位置:
  - `packages/desktop/src/main/index.ts:211` —— `if (testMode || process.platform !== "darwin") Menu.setApplicationMenu(null);` macOS 生产环境保留默认菜单,View → Reload / Cmd+R 可用。
  - `packages/desktop/src/main/index.ts:1240` —— `panes.close()` 只在 `before-quit` 执行。
  - `packages/desktop/src/renderer/BrowserPane.tsx:97` —— 隐藏浏览器视图依赖 React effect cleanup 发送 `browserBounds(id, null)`;document unload 时 React cleanup 不执行。
- 机理与后果:
  1. 当前显示的 `WebContentsView` 仍是 contentView 的子节点,按旧 bounds 继续渲染在重载后的 UI 之上并吞掉点击。
  2. 每个打开的终端 tab 的 pty 进程继续运行(只有 before-quit 会杀),渲染层已遗忘——不可见的 shell(如正在跑的 dev server)无从触达。
  3. 浏览器 view 在 `PaneServices.browsers` 中泄漏,反复重载耗尽 12 槽位上限("请先关闭部分浏览器标签"而可见 tab 为零)。
- 复现:macOS 打包版 → 打开一个浏览器 tab(加载页面)和一个终端 tab → 焦点切回聊天区 → Cmd+R。

### 6.【中】浏览器面板每次 URL 变化都解绑/重挂 WebContentsView,页内跳转丢键盘焦点

- 位置:`packages/desktop/src/renderer/BrowserPane.tsx:99` —— effect 依赖 `[state.id, state.url, visible]`,cleanup 发 `browserBounds(state.id, null)`;`packages/desktop/src/main/pane-services.ts:230-253` —— `removeChildView` 后再 `addChildView`。
- 机理:effect 只需要知道"是否有 URL",却依赖了 URL 字符串本身。锚点跳转(`#section`)、SPA `pushState`/`replaceState`、重定向都会经 `did-navigate-in-page` 更新 `state.url` → 触发 cleanup → 主进程摘除 view(键盘焦点回到宿主)→ 下一帧重挂(焦点不恢复),且至少有一帧空白。
- 场景:0.2.77 的典型流程——浏览器面板打开本地 HTML,点击页内锚点后,打字进的是 composer 而不是网页;localhost SPA 切路由同理。
- 修复方向:依赖 `Boolean(state.url)` 而非 URL 字符串。

### 7.【中】快速对话"空闲过期"可在窗口仍可见时清掉用户正在看的对话

- 位置:
  - `packages/desktop/src/main/quick-chat-window.ts:466-471` —— `show()` 里 `const resetting = reset ?? this.options.host.resetIfExpired();` 无条件执行,`wasHidden` 只用于其他分支。
  - `packages/desktop/src/main/index.ts:578-580` —— 设置页"打开快速对话"按钮(`QuickChatSettings.tsx:39` → `openQuickChat`)直达 `quickChat.show()`,无可见性守卫。
- 场景:弹窗保持可见、距上次**接受的发送** ≥15 分钟(流式输出和打字都不续期),点设置页"打开快速对话"→ 屏上对话与未发送草稿被直接重置为新会话。快捷键路径(toggle 对可见窗口走 hide)不受影响,只有按钮路径中招。
- 修复方向:`show()` 在 `this.visible && window.isVisible()` 时跳过 `resetIfExpired`,把过期重置限制在真正的"重新打开"。

### 8.【低】终端 `exited` 事件字段被发出但渲染层从不消费

- 位置:`packages/desktop/src/main/pane-services.ts:56` 发出 `{ data: "[终端已退出 N]", exited: true }`;`packages/desktop/src/shared/bridge.ts:286` 定义了 `exited?: boolean`;`packages/desktop/src/renderer/pane-store.ts` 全文无一处读取 `exited`(grep 证实);之后 `terminalInput` 抛 `not_found: 终端已关闭`(`pane-services.ts:57-60`),错误经全局 toast 显示。
- 场景:终端里输入 `exit`(或 shell 崩溃)后 tab 仍开着,之后每敲一个键都触发一次"终端已关闭" toast。
- 修复方向:渲染层收到 `exited: true` 时标记/关闭该 tab。

### 9.【低】项目列表排序不持久,重启后侧栏顺序漂移

- 位置:
  - `packages/desktop/src/main/state-schema-v1.ts:4-6` —— `projects.sort_key REAL NOT NULL DEFAULT 0`。
  - `packages/desktop/src/main/state-store.ts:332-340` —— `upsertProject` 的 INSERT 不含 sort_key 列(吃默认值 0);只有离线迁移路径 `setProjects`(`state-store.ts:347,354`)会写 sort_key。
  - `packages/desktop/src/main/session-host.ts:586-594` —— 运行期 `addProject` 只调 `upsertProject`;读取用 `ORDER BY sort_key,id`(`state-store.ts:343`)。
- 证据(scratch 复现):`setProjects([First, Second])` 后 `upsertProject(Third)` → 重启读取顺序为 `[First, Third, Second]`(sort_key 全 0,UUID tie-break),与会话内追加序 `[First, Second, Third]` 不一致。
- 影响:无数据丢失,但用户的项目侧栏顺序在每次重启后随机漂移。

### 10.【低】大补丁视图中 CRLF 文件每行渲染成双倍行高

- 位置:`packages/ui/src/components/DiffView.tsx:118`(`split("\n")` 保留行尾 `\r`)+ `workbench.css:538-542`(`.diff-row { white-space: pre; }`);`DiffView.tsx:233` 大补丁(>1200 行或 >180KB)强制 PlainPatch。
- 机理:diff worker 用 jsdiff 对原始字节生成补丁,CRLF 行尾保留 `\r`;`white-space: pre` 下尾部 CR 是保留的段中断,每行多出一个空行,复制的文本也带杂散 CR。单侧路径(`split(/\r?\n/)` 与 `patchPreviewLines`)不受影响。
- 场景:agent 修改了 >1200 行的 Windows 格式文件(CSV/sln),变更预览全部隔行显示。

### 11.【低】ICO 图标解码器拒绝声明了调色板色数的真实图标

- 位置:`packages/desktop/src/main/web-icon-image.ts:84`(`icoFrame` 对 `bColorCount !== 0` 一律拒绝)。
- 证据(合成 ICO 实测):同一张 32x32 8bpp 图标,`bColorCount=16` → `Icon unavailable`,逐字节相同但 `bColorCount=0` → 正常解码;4bpp + `bColorCount=2` 同样被拒(`bColorCount=256` 溢出为字节 0 反而通过)。
- 影响:0.2.85"Fix DeepSeek source icon decoding"救回了一类图标,但常见调色板图标仍静默回退成通用地球图标。失败闭合,无崩溃/内存问题。

### 12.【低】空文件的 write 流式预览显示原始 Parameters JSON

- 位置:`packages/ui/src/components/ToolBlock.tsx:117-120` —— `content.trim()` 为空串(合法的空文件写入)时落入 Parameters 分支,显示 `{"file_path": ...}` 而非空内容预览;完成后状态又显示真实(空)补丁,流式与最终状态不一致。

### 13.【低】保留名命令可以创建但永远无法通过 slash 调用

- 位置:`packages/desktop/src/main/custom-commands.ts:146-152`(`validateCustomCommandName` 只做字符正则,不拒绝 `init`/`compact`/`side`/`btw`);分发层排除(`custom-command-expansion.ts:3-12`)、slash 菜单隐藏(`store.ts:317-329` + `command-suggestions.ts:3` 的 `unavailableNames`),且 `list()` 不产生任何诊断(`unsupported_name` 正则放行)。
- 场景:`store.create({ name: "init", prompt: "X" })` 成功,命令设置里可见,slash 菜单永不显示,`/init x` 执行的是内置命令。
- 修复方向:create/update 拒绝保留名或给出诊断。

### 14.【低】未注册的孤儿符号链接永久占用命令名,应用内无恢复路径

- 场景:导入流程在 `symlink()`(`command-import.ts:401`)与 `saveLinks()` 之间崩溃,或用户手动放入符号链接 → `list()` 诊断 `unsafe_path`,`delete()` 因要求导入器注册而拒绝(实测 throw 且文件保留),重新导入同名命令报 `targetExists`,唯一恢复方式是 shell 手动 `rm`。
- 属故意 fail-safe,但缺少可操作的 UI 指引。

### 15.【低】快速对话暖重开在渲染器重载期间可能短暂白窗

- 0.2.96 的"空白重开修复"(`needsSessionFrame`/`presentationVersion`)只覆盖会话/模式变更;`this.loading` 只跟踪首次加载,renderer reload 不设置 `needsSessionFrame`。macOS 生产环境 Cmd+R 重载快速对话面板后立刻唤起,暖路径会 present 一个尚无内容的窗口,约 100-300ms 后自愈。代码在 `did-start-navigation`(`quick-chat-window.ts:356`)已预期 reload 会发生(丢弃草稿附件),但未将其视为"帧失效"。

### 16.【低】其余小型问题

- 答案来源摘要 HTML 实体解码不一致:`packages/ui/src/components/answer-sources.ts:50-71` 的 `fetchExcerpt` 在剥标签**之后**才 `decodeString`,而搜索 snippet(`shortText`)完全不解码——来源弹窗中 `&amp;` 等原样显示、两种来源行为不一致。仅显示层问题,React 文本节点渲染,无 XSS。
- 命令重命名失败丢失 disabled 覆盖:`custom-commands.ts:623-632` 在 publish 前迁移覆盖到新 id,publish/unlink 失败回滚保留旧文件时,旧 id 命令会自动恢复启用(代码注释表明是已接受的取舍)。
- frontmatter 解析保真度:`metadataValue`(`custom-commands.ts:86-98`)会把续行中的整行注释折入值(`description: Summary\n  # note` → `"Summary # note"`);块式 YAML 列表的 `skills:`(`flatMetadataValue`)解析为 `[]`,静默丢弃 skill 名(影响会话分发时注入 skill 正文)。均源于"非通用 YAML 求值器"的定位。

---

## 四、设计级注意事项(非缺陷,但值得知晓)

- `releaseQueuedInput`(`state-store.ts:636`)是死代码:仅在测试中调用。崩溃窗口(`reserveQueuedInput` 与 transcript 追加之间)阻塞的任务只能删除,预留的释放 API 从未接线。
- `create` 恢复意图与孤儿 transcript 文件永不回收:`session-host.ts:802` 持久化 create 意图后若在 `completeIntent` 前崩溃,init 的意图循环(只处理 accept-input/replace/fork)跳过它,孤儿 `<id>.jsonl` 与意图行永久存在。受崩溃次数约束。
- `task_runtime` 每次运行累积一行(`(task_id, kind, instance_id)` upsert,仅随任务删除),数百次运行 → 每任务数百小行。审计语义,无害增长。
- 快速对话附件内存预算会重复计数重试的同一图片并持续增长(`quick-chat-attachments.ts` 的 `bytes()`/`markUsed`):~10MB 图片数次"发送失败→恢复→重试"后触发 `busy: 临时图片内存已达上限`,直到新对话/过期。有测试断言此边界,属设计行为。

---

## 五、检查过且确认无问题的方面(简列)

- **SQL 安全**:所有语句参数化绑定,模板字面量只插值固定词表/数字;无注入。
- **事务与崩溃恢复**:`BEGIN IMMEDIATE`/嵌套 savepoint、失败审计、嵌套失败回滚均有测试;热 WAL 只读预检、JSONL 为权威的索引修复、无换行尾记录的校验与修复均经对抗性实验验证。
- **删除边界与清理**:墓碑 + 队列清理;引用检查、受管路径包含性、符号链接拒绝、header ID 所有权验证;替换中意图正确保护两代文件。
- **任务分组**:零 revision 抖动的幂等写入;非法移动原子回滚;删除组时成员(含墓碑)脱离。
- **卡死恢复**:持久化 `running` → `interrupted`;外 epoch 行中断;分发中的队列输入重保留但不重放。
- **时间戳**:全库统一 epoch-ms,无秒/毫秒或 ISO/epoch 混用。
- **快捷键**:CmdOrCtrl/⌘/物理键码往返、跨作用域重复检测、~15 组保留组合、注册/注销/恢复无泄漏、原生修饰键双路径幂等。
- **浏览器安全**:`will-navigate`/`will-redirect`/`setWindowOpenHandler` 全 guarded,http/https/file 白名单、拒绝凭据与远程 file 主机、沙箱/contextIsolation/权限拒绝齐备;`webUrl` 私网/IPv6/IPv4 简写/Unicode 主机等 36 例筛查全过。
- **凭据存储**:全程 safeStorage 加密(`credentials.enc`),不可用时仅内存持有并删除落盘文件;quick chat 桥不暴露凭据读取;`getWebSearchCredentials` 为专用零参白名单方法。
- **0.2.84 流式部分 JSON 解析**(`readPartialString`):对混合字符串的每个前缀验证正确(未闭合转义、代理对拆分等)。
- **侧聊继承**(0.2.67-0.2.70):工作目录、模型/思考级别按截断快照继承;继承前缀经深度校验(id/parentId 重映射、工具输出路径迁移、压缩锚点),校验不过则 `turnsKnown:false` 隐藏;分页游标边界正确。
- **Token/成本计算**(0.2.60-0.2.66):所有除法有守卫,ms→tok/s 换算正确,缓存率有界 [0,1];0.2.63 去重干净(遗留一个无害的死函数 `averageCacheHitRate`)。

---

## 六、优先修复建议

1. **#1** —— 一行守卫 `process.getSystemVersion?.()` 即可让 22 个凭据安全测试在 macOS 恢复执行。
2. **#4** —— 幽灵队列项:`submit()` 提交前重读 `this.get(id)`,或让 finally 的 `restore` 走串行链。
3. **#5 / #6** —— 浏览器面板生命周期(重载清理)与 effect 依赖项(`Boolean(state.url)`)。
4. **#2 / #3** —— 扫描中止语义与冲突原因分类(均已有失败测试作为行为规约)。
