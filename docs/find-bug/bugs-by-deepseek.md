# ZPI 深度缺陷审计（DeepSeek）

- 审计基线：`688b8e8`（0.2.96）
- 环境：macOS，Node.js 24.12.0，Electron 41.10.7
- 静态检查：`npx tsc --noEmit` 通过；`npx biome check .` 无错误（4 warnings）
- 结论：发现 **7 个可确认的产品/边界问题**、**1 个代码级竞态风险**，以及一批与近期存储/UI 重构脱节的测试问题。当前代码树不是全绿。

> 路径均相对于仓库根目录。

---

## 结论摘要

| 级别 | 问题 | 主要影响 |
| --- | --- | --- |
| 中 | 内联重命名输入框被 dnd-kit 的 `aria-disabled` 标记为禁用 | 屏幕阅读器无法使用；3 个桌面 E2E 稳定失败 |
| 中高 | 用户消息包含 `# userselect` 块时解析失败 | 引用选择全部丢失，内部 JSON 被当成正文 |
| 中 | 自定义命令扫描达到 `maxEntries` 后仍返回部分结果 | 命令列表不完整且依赖文件系统遍历顺序 |
| 中 | 自定义命令拒绝任意 symlink 祖先 | macOS `/tmp`、`/var` 或 symlink home 下命令完全不可用 |
| 中低 | 预览卡片从代码块中提取引用 | 代码示例会生成虚假预览卡片 |
| 中低 | `~//...` 逃出 home 目录 | home-relative 路径包含性失效 |
| 低 | macOS 大小写不敏感文件系统下导入冲突原因错误 | UI 文案错误，测试永久红 |
| 低中 | 草稿自动保存在请求在途时可能丢掉最后一次编辑 | 崩溃/强退时最后输入可能未落盘 |

---

## 1. 内联重命名输入框被标记为 disabled

### 现象

新建分组或重命名任务时，输入框可以获得焦点，但 DOM 祖先 `div.task-group-header` 带有 `aria-disabled="true"`。屏幕阅读器会把整个区域视为禁用，Playwright 也认为输入框不可编辑。

### 证据

运行：

```bash
node scripts/test-desktop.ts tests/desktop/task-groups.spec.ts \
  -g "group menus preserve"
```

失败信息：

```text
locator.fill: Target page, context or browser has been closed
Call log:
  - waiting for getByRole('textbox', { name: '重命名分组', exact: true })
    - locator resolved to <input value="New Group" aria-label="重命名分组" .../>
  - attempting fill action
    - element is not enabled
```

抓取 DOM 链：

```text
INPUT.task-group-name-input disabled=false ariaDisabled=null
LABEL.task-group-name-editor disabled= inert=false ariaDisabled=null
DIV.task-group-title-wrap disabled= inert=false ariaDisabled=null
DIV.task-group-header disabled= inert=false ariaDisabled=true
SECTION.task-group ...
```

### 根因

- [`TaskGroups.tsx:219`](../../packages/desktop/src/renderer/TaskGroups.tsx#L219)：`useDraggable({ disabled: renaming })`
- [`TaskGroups.tsx:269`](../../packages/desktop/src/renderer/TaskGroups.tsx#L269)：把 `draggable.attributes` 展开到包含输入框的整个 header
- [`TaskGroupRow.tsx:66`](../../packages/desktop/src/renderer/TaskGroupRow.tsx#L66)：任务行同样使用 `disabled: ... || renaming`
- [`TaskGroupRow.tsx:110`](../../packages/desktop/src/renderer/TaskGroupRow.tsx#L110)：同样展开 `draggable.attributes`

dnd-kit 在 `disabled: true` 时会在 attributes 中生成 `aria-disabled="true"`；输入框自身没有 `disabled`，但祖先的 ARIA 语义会传播到可访问性树。

### 建议

- 重命名时不要展开 `draggable.attributes`，或只把拖拽监听器绑定到独立的拖拽手柄。
- 至少过滤掉 `aria-disabled`，不要把拖拽禁用语义施加到包含输入框的祖先。
- 修复后应同时覆盖分组重命名和任务行重命名两条路径。

---

## 2. 用户消息包含 `# userselect` 块时解析失败

### 现象

当用户消息正文本身以 `# userselect:` 代码块结尾时，`buildSelectionPrompt` 再追加一个真正的引用块后，`parseSelectionPrompt` 会解析失败：

- 返回的 `text` 包含两个块（包括内部机器 JSON）
- 返回的 `selections` 为空

如果用户编辑队列中的这类消息，内部格式会被重新显示到输入框，原有的引用选择全部丢失。

### 复现

```ts
const refs = [{ text: "const a = 1;", path: "src/a.ts" }];
const text = "hello\n\n# userselect:\n```userselect\n[]\n```";

buildSelectionPrompt(text, refs);
parseSelectionPrompt(buildSelectionPrompt(text, refs));
```

实际输出：

```json
{
  "text": "hello\n\n# userselect:\n```userselect\n[]\n```\n\n# userselect:\n```userselect\n[{\"path\":\"src/a.ts\",\"text\":\"const a = 1;\"}]\n```",
  "selections": []
}
```

### 根因

[`conversation-selections.ts:128`](../../packages/ui/src/conversation-selections.ts#L128)：

```ts
const match = /(?:\n\n)?# userselect:\n```userselect\n([\s\S]*?)\n```\s*$/.exec(text);
```

正则从**第一个** `# userselect:` 开始匹配，并一直吞到结尾。当正文内部已经有一个块时，捕获到的 JSON 不合法，`JSON.parse` 抛错后函数原样返回整段文本和空选择。

### 影响链

- [`Conversation.tsx:134`](../../packages/ui/src/components/Conversation.tsx#L134)：显示用户消息
- [`session-host.ts:259`](../../packages/desktop/src/main/session-host.ts#L259)：编辑队列消息时恢复草稿

### 建议

- 从文本末尾向前查找最后一个 userselect 块，而不是从第一个开始。
- 或使用不可与正文冲突的随机分隔符/长度前缀。
- 解析失败时只保留正文并清空选择，不要让内部块进入可见文本。

---

## 3. 自定义命令扫描达到 `maxEntries` 后仍返回部分结果

### 现象

`CustomCommandsStore.list()` 在扫描条目数超过 `maxEntries` 时，会保留已经读取到的命令，导致返回结果不完整，并且返回哪几个命令取决于 `fs.opendir` 的顺序。

### 复现

在 `.zpi/commands` 放 `a.md`、`b.md`、`c.md`，然后：

```ts
const store = new CustomCommandsStore({
  rootDirectory: root,
  stateFilePath: state,
  limits: { maxEntries: 1 },
});
await store.list();
```

本机 APFS 输出：

```text
maxEntries 1 => commands [ 'b.md' ] diagnostics [ 'scan_limit' ]
maxEntries 2 => commands [ 'b.md', 'c.md' ] diagnostics [ 'scan_limit' ]
maxEntries 3 => commands [ 'a.md', 'b.md', 'c.md' ] diagnostics []
```

现有测试 [`custom-commands.test.ts:513`](../../packages/desktop/test/custom-commands.test.ts#L513) 的期望是：

```ts
expect(count.commands).toEqual([]);
```

### 根因

[`custom-commands.ts:490`](../../packages/desktop/src/main/custom-commands.ts#L490) 在超过限制时只 `break`，没有清空已经收集的 `commands`：

```ts
if (entriesSeen > this.limits.maxEntries) {
  exhausted = true;
  diagnostics.push({ code: "scan_limit", ... });
  break;
}
```

### 影响

- 设置页展示不完整的命令列表。
- 结果依赖文件系统遍历顺序，不同机器/不同目录内容会返回不同命令。
- 如果未来有调用方用 `list()` 判断名称是否可用，可能产生误判。

### 建议

按测试表达的安全意图 fail-closed：超限时清空 `commands`，只返回 `scan_limit` 诊断；或让调用方显式区分“结果完整”和“结果被截断”。

---

## 4. 自定义命令对符号链接祖先过度拒绝

### 现象

macOS 的 `/tmp`、`/var` 本身是符号链接（`/var -> private/var`）。如果自定义命令目录位于这些路径下，`safeDirectory` 会拒绝整个目录，导致命令完全不可用。

### 复现

```ts
const base = await mkdtemp(join(tmpdir(), "zpi-audit-cmd-"));
const root = join(base, ".zpi", "commands");
await mkdir(root, { recursive: true });
await writeFile(join(root, "one.md"), "Hello");

const store = new CustomCommandsStore({
  rootDirectory: root,
  stateFilePath: join(base, ".zpi", "state.json"),
});
console.log(await store.list());
```

本机输出：

```json
{
  "commands": [],
  "diagnostics": [
    {
      "code": "unsafe_path",
      "message": "unsafe_path: Command path contains a symlink or non-directory ancestor",
      "path": ".../.zpi/commands"
    }
  ]
}
```

将 `root` 替换为 `realpath(root)` 后命令正常返回。

### 根因

[`custom-commands.ts:212`](../../packages/desktop/src/main/custom-commands.ts#L212) 的 `safeDirectory` 从文件系统根开始逐级 `lstat`，只要遇到任意符号链接就失败；它不会先规范化根目录。

测试 fixture 在 [`custom-commands.test.ts:20`](../../packages/desktop/test/custom-commands.test.ts#L20) 里使用了 `fs.realpath`，因此掩盖了这个问题。

### 影响

- 项目通过 `/tmp`、`/var`、外部卷或 dotfiles symlink 访问时，项目级命令不可用。
- 用户 home 本身是 symlink 时，用户级命令也不可用。

### 建议

- 构造 store 时先 `realpath(rootDirectory)`。
- 或在 `safeDirectory` 中只拒绝“解析后跳出允许根目录”的 symlink，而不是拒绝所有 symlink 祖先。

---

## 5. 预览卡片会从代码块中的引用生成

### 现象

`extractAssistantFileReferences` 会把 fenced code / inline code 里的 `::zcode-file-citation{...}` 和 Markdown 链接当成真实引用，生成预览卡片。

### 复现

```ts
extractAssistantFileReferences(
  '```text\n::zcode-file-citation{path="report.pdf"}\n```',
  "/Users/jiezhou/project",
);
```

实际返回：

```json
[{ "kind": "pdf", "path": "/Users/jiezhou/project/report.pdf", "raw": "report.pdf" }]
```

内联代码：

```ts
extractAssistantFileReferences(
  '`::zcode-file-citation{path="report.pdf"}`',
  "/Users/jiezhou/project",
);
```

同样会返回引用。

### 根因

- [`assistant-file-references.ts:157`](../../packages/ui/src/preview/assistant-file-references.ts#L157) 直接遍历 `extractFileCitationDirectives(content)`，没有排除代码区域。
- [`file-citation.ts:203`](../../packages/ui/src/file-citation.ts#L203) 的 remark 插件则明确跳过 `code`、`inlineCode`、`html` 等节点。
- `projectFileCitations` 也使用 `codeRanges` 保护代码块。

渲染层和提取层行为不一致。

### 影响

模型解释引用语法、或在代码示例中展示该指令时，会凭空出现一个预览卡片，甚至尝试打开示例路径。

### 建议

让 `extractAssistantFileReferences` 复用 `codeRanges`/`markdownFence` 的保护范围；Markdown 链接的提取也应跳过代码块。

---

## 6. `~//...` 逃出 home 目录

### 现象

`~` 开头的 Markdown 链接本应解析到 home 目录下，但 `~//...` 会被解析成根目录或任意绝对路径。

### 复现

```ts
resolveMarkdownFileLink(
  "/Users/jiezhou/project",
  "~//Users/other/secret.md",
  { homePath: "/Users/jiezhou" },
);
```

实际返回：

```json
{ "path": "/Users/other/secret.md", "lineNumber": null, "columnNumber": null }
```

其他结果：

```text
~//etc/passwd      => /etc/passwd
~///etc/passwd     => //etc/passwd
~\/etc/passwd      => /etc/passwd
```

### 根因

- [`preview-file-path.ts:69`](../../packages/ui/src/preview/preview-file-path.ts#L69) 先去掉 `~/`：
  ```ts
  return joinFilePath(homePath, homeRelativePath.slice(2).replace(/[\\/]/g, separator));
  ```
- [`path.ts:29`](../../packages/ui/src/preview/path.ts#L29) 的 `joinFilePath` 对绝对 child 直接返回 child：
  ```ts
  if (isAbsoluteFilePath(childPath)) return childPath;
  ```

因此 `~//Users/...` 的 `/Users/...` 被当成绝对路径。

### 影响

- `~` 的 home-relative 语义失效。
- 当前应用允许绝对路径预览，所以不是直接提权；但它会绕过 UI 对“home 内”的假设，未来若收紧绝对路径预览，这里会成为绕过点。
- `~///etc/passwd` 在 Windows 上还可能被当成 UNC 路径。

### 建议

在调用 `joinFilePath` 前去掉 child 的前导分隔符；或显式拒绝 `~` 后面的绝对路径。`~//...` 应规范化为 home 下路径或返回 `null`。

---

## 7. macOS 大小写不敏感文件系统下导入冲突原因错误

### 现象

先导入 `.claude/commands/review.md`，再导入 `.codex/commands/REVIEW.md` 时，第二个文件被跳过，但原因报告为 `targetExists`，而不是 `sameNameExists`。

### 证据

```bash
npx vitest run packages/desktop/test/command-import.test.ts
```

失败：

```text
AssertionError: expected [ undefined, 'targetExists', 'targetExists' ]
to deeply equal [ undefined, 'sameNameExists', 'targetExists' ]
```

### 根因

[`command-import.ts:221`](../../packages/desktop/src/main/command-import.ts#L221)：

```ts
private async conflict(path: string, names: Set<string>) {
  try {
    await lstat(join(this.target, path));
    return "targetExists";
  } catch (error) {
    ...
  }
  return names.has(nameKey(path)) ? "sameNameExists" : undefined;
}
```

在 APFS 等大小写不敏感文件系统上，`lstat("REVIEW.md")` 会解析到已经导入的 `review.md`，于是永远不会走到 `names.has(...)`。

### 影响

- 不会丢数据，但 UI 文案错误：用户看到“文件已存在”，而不是“同名已存在”。
- 测试在 macOS 上永久红，Linux/大小写敏感文件系统则通过，形成跨平台不一致。

### 建议

先做大小写不敏感的 `names` 冲突判断，再检查目标文件；或者比较真实 `basename` 的大小写，区分“同名”和“同文件”。

---

## 8. 草稿自动保存竞态（代码级风险，未端到端复现）

### 现象

当一次 `saveDraft` 请求仍在途时，新的编辑定时器触发，`saveDraft` 会直接返回旧的 `pending`，不会为最新 revision 安排保存。之后如果没有第三次编辑或显式 flush，最后一次编辑可能一直未落盘。

### 代码路径

[`store.ts:100`](../../packages/desktop/src/renderer/store.ts#L100)：

```ts
function saveDraft(id: string): Promise<void> {
  if (!draftSaveTimers.has(id)) {
    const pending = draftSaveRequests.get(id);
    if (pending || !draftSaving.has(id)) return pending ?? Promise.resolve();
  }
  ...
}
```

可能交错：

1. 编辑 A，200ms 定时器触发，发送 rev1，`pending` 存在。
2. 请求未返回时编辑 B，设置新定时器。
3. 新定时器触发，发现 `pending`，直接 `return pending`；定时器被消费，但 B 没有新的保存任务。
4. `pending` 返回后，`draftSaving` 因 revision 已变化而保持 true；如果没有第三次编辑或 `flushDrafts`，B 一直未保存。

### 影响

- 正常退出、切换会话、页面隐藏时会 `flushDrafts`，大多数情况下能兜底。
- 强制退出/崩溃时会丢失最后一次编辑。
- `draftSaving` 可能长期为 true，影响 `trimViews` 的缓存裁剪判断。

### 建议

- `pending` 完成后检查 `draftSaving` 和当前 revision，必要时重新调度保存。
- 或在 `saveDraft` 返回 `pending` 后，在 `.finally` 中比较 revision 并补一次保存。

---

## 测试基线

### 单元测试

```text
Test Files  3 failed | 250 passed (253)
Tests       2 failed | 3005 passed | 23 skipped (3030)
```

具体失败：

1. `packages/desktop/test/command-import.test.ts`
   - `skips exact and case-insensitive conflicts, including another selected source`
   - macOS 大小写不敏感文件系统导致 `targetExists` vs `sameNameExists`（见第 7 条）。
2. `packages/desktop/test/custom-commands.test.ts`
   - `bounds file sizes, directory depth, scan entries and total bytes`
   - `maxEntries: 1` 期望 `[]`，实际返回 `b.md`（见第 3 条）。
3. `packages/desktop/test/web-credentials-ipc.test.ts`
   - 整个 suite 在 `beforeAll` 失败，22 个测试全部 skipped。

```text
ZPI 启动失败 TypeError: process.getSystemVersion is not a function
  at launch (packages/desktop/src/main/index.ts:216:66)
```

[`index.ts:216`](../../packages/desktop/src/main/index.ts#L216) 直接调用 Electron 专属的 `process.getSystemVersion()`。生产 Electron 有该 API，但 Node 测试环境没有；测试 mock 了 `electron`，没有 mock `process`。

建议改成：

```ts
Number.parseInt(process.getSystemVersion?.() ?? "", 10) < 26
```

这样也能让 `main/index.ts` 在非 Electron 环境下安全导入，恢复 22 个凭据 IPC 安全断言。

### 桌面 Electron 测试

抽样运行 6 个 spec、24 个用例，**18 个失败**：

| spec | 失败/总数 | 主要归因 |
| --- | --- | --- |
| `quick-chat.spec.ts` | 3/3 | 测试在应用初始化创建默认草稿之前取基线 |
| `review-regressions.spec.ts` | 4/7 | 草稿文件路径过期；hidden test mode 跳过 `setEnabled(false)`；reading position 未归因 |
| `task-groups.spec.ts` | 4/6 | 3 个 `aria-disabled` 产品缺陷；1 个置顶行选择器过期 |
| `web-settings.spec.ts` | 2/2 | 测试查找 `取消esc`，实际可访问名是 `取消` |
| `compaction.spec.ts` | 4/4 | 测试写入旧 `dir/agent/settings.json`，应用读取 generation 下的 settings |
| `history-auto-load.spec.ts` | 1/2 | 测试在 `run-20` 尚未加载时读取锚点位置 |

#### quick-chat：不是 quick chat 污染主任务列表

单独诊断时，打开快速对话**之前**主任务列表已经有一个默认“新对话”草稿：

```text
COUNTS_BEFORE_OPEN [1,1,1,1,1,1,1,1,1,1,1,1]
BEFORE {"ok":true,"value":[{"title":"新对话","draft":true,...}]}
AFTER  {"ok":true,"value":[{"title":"新对话","draft":true,...}]}
```

失败原因是测试在 `initialize()` 完成之前就取了 `before` 基线。测试应等待任务列表稳定后再记录基线。不过这确实说明：主窗口在初始化完成前已经允许输入，初始化完成后再创建/选中默认草稿，存在用户输入与默认会话创建的时序耦合，值得单独加一个“初始化完成前禁用输入”或“初始化完成后再取基线”的测试。

#### review-regressions：测试与存储迁移脱节

- 测试读取 `dir/drafts/<id>.json`：
  [`review-regressions.spec.ts:65`](../../tests/desktop/review-regressions.spec.ts#L65)、[`:120`](../../tests/desktop/review-regressions.spec.ts#L120)。
  当前草稿由 `StateStore.saveDraft` 存入 SQLite 的 `drafts` 表，不再写 JSON 文件。
- hidden test mode 下 `window.setEnabled(false)` 被刻意跳过：
  [`index.ts`](../../packages/desktop/src/main/index.ts) 的退出流程只在 `!hiddenTestMode` 时禁用窗口，但测试仍期望禁用。
- reading position 用例期望 `scrollTop === 100`，实际 3850；未完全归因，建议单独检查滚动恢复。

#### task-groups：3 个真实缺陷 + 1 个测试选择器错误

- 重命名输入框 `aria-disabled` 是真实产品缺陷，见第 1 条。
- 置顶后任务行从 `.task-groups` 移到 `.pinned-tasks`，测试仍用旧选择器：
  [`task-groups.spec.ts:410`](../../tests/desktop/task-groups.spec.ts#L410)。

#### web-settings：可访问名称过期

按钮实际快照：

```yaml
- button "取消" [ref=f1e7]:
  - text: 取消
  - generic [aria-hidden]: esc
```

测试查找：

```ts
page.getByRole("button", { name: "取消esc", exact: true })
```

[`web-settings.spec.ts:85`](../../tests/desktop/web-settings.spec.ts#L85) 应改为 `取消`。

#### compaction：测试 fixture 写错 settings 路径

测试把 `keepRecentTokens` 写到：

```text
dir/agent/settings.json
```

但 storage migration 后应用数据根下的 `active-generation.json` 指向 `storage/<generationId>/`；`SessionHost` 的 `dir` 是该 generation 目录，`createAgentSession` 的 `agentDir` 是 `<generation>/agent`。因此压缩配置没有生效，压缩分隔条不会出现。

测试应写入 `storage/<generationId>/agent/settings.json`，或通过设置 API 注入压缩配置。

#### history-auto-load：锚点尚未加载

测试先取 `[data-run-id="run-20"]` 的位置，再滚动加载更早消息；但初始只加载最后 10 条，`run-20` 根本不在 DOM 中，`before` 是 `undefined`。因此比较结果 47px 是测试自身造成的，不是滚动锚定回归。

---

## 修复优先级建议

1. **修 `aria-disabled` 重命名问题**，恢复可访问性和 3 个 E2E。
2. **修 userselect 解析和 `~//` 路径包含**，避免引用丢失和路径逃逸。
3. **修自定义命令扫描限额与 symlink 祖先处理**。
4. **让预览引用提取跳过代码块**。
5. **修 `process.getSystemVersion` 兼容性**，恢复 22 个凭据 IPC 安全断言。
6. **更新过期桌面测试**：草稿 SQLite 路径、compaction settings generation 路径、quick-chat 初始化等待、置顶行选择器、`取消` 名称、history 锚点改用已加载 run。
7. **处理草稿保存竞态和 macOS 导入文案**等低概率/低影响问题。

---

## 附：本次审计使用的关键命令

```bash
npx tsc --noEmit
npx biome check .
npx vitest run
npx vitest run packages/desktop/test/web-credentials-ipc.test.ts
npx vitest run packages/desktop/test/command-import.test.ts
npx vitest run packages/desktop/test/custom-commands.test.ts
npm run build
node scripts/test-desktop.ts tests/desktop/quick-chat.spec.ts
node scripts/test-desktop.ts tests/desktop/review-regressions.spec.ts
node scripts/test-desktop.ts tests/desktop/task-groups.spec.ts
node scripts/test-desktop.ts tests/desktop/web-settings.spec.ts
node scripts/test-desktop.ts tests/desktop/compaction.spec.ts tests/desktop/history-auto-load.spec.ts
```

以上桌面测试均为隐藏窗口模式，未打开用户可见窗口；`npm run build` 通过。
