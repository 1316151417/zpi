# 源码到文档的完整索引

本表按当前受 Git 管理的源码建立对应关系。每个源文件只有一个主要说明页；跨层机制通过该页的相关链接继续阅读。它用于发现遗漏和定位维护位置，不表示每个函数都需要单独写一篇文章。

## 范围

| 范围 | 文件数 |
| --- | ---: |
| `packages/agent/src` 中的 TS/TSX、CSS、JSON、HTML | 6 |
| `packages/ai/src` 中的 TS/TSX、CSS、JSON、HTML | 46 |
| `packages/coding-agent/src` 中的 TS/TSX、CSS、JSON、HTML | 51 |
| `packages/desktop/src` 中的 TS/TSX、CSS、JSON、HTML | 276 |
| `packages/ui/src` 中的 TS/TSX、CSS、JSON、HTML | 103 |
| native、scripts、examples 支持文件 | 27 |

测试用例按各原理页的回归入口及包内 test 目录维护；测试基础设施见[测试原理](testing.md)。图片、字体、音频、Office fixtures 等资源不逐件列作代码模块，归属见下方资源表。

## 按主要说明页定位

### [Agent 循环与工具调度](agent-loop.md)

| 目录 | 文件 |
| --- | --- |
| `packages/agent/src` | [agent-loop.ts](../../packages/agent/src/agent-loop.ts) · [agent.ts](../../packages/agent/src/agent.ts) · [index.ts](../../packages/agent/src/index.ts) · [streaming-tool-coordinator.ts](../../packages/agent/src/streaming-tool-coordinator.ts) · [tool-execution.ts](../../packages/agent/src/tool-execution.ts) · [types.ts](../../packages/agent/src/types.ts) |

### [后台命令与交互终端](background-terminal.md)

| 目录 | 文件 |
| --- | --- |
| `packages/desktop/src/main` | [background-tasks.ts](../../packages/desktop/src/main/background-tasks.ts) · [shell-environment.ts](../../packages/desktop/src/main/shell-environment.ts) · [task-processes.ts](../../packages/desktop/src/main/task-processes.ts) · [terminal-profile.ts](../../packages/desktop/src/main/terminal-profile.ts) · [terminal-shell.ts](../../packages/desktop/src/main/terminal-shell.ts) |
| `packages/desktop/src/renderer` | [BackgroundTaskPane.tsx](../../packages/desktop/src/renderer/BackgroundTaskPane.tsx) · [TerminalPane.tsx](../../packages/desktop/src/renderer/TerminalPane.tsx) · [terminal-presentation.ts](../../packages/desktop/src/renderer/terminal-presentation.ts) |
| `packages/ui/src/components` | [process-presentation.ts](../../packages/ui/src/components/process-presentation.ts) |

### [自定义命令的存储、导入与执行](commands.md)

| 目录 | 文件 |
| --- | --- |
| `packages/coding-agent/src/core` | [commands.ts](../../packages/coding-agent/src/core/commands.ts) |
| `packages/desktop/src/main` | [command-import.ts](../../packages/desktop/src/main/command-import.ts) · [custom-command-expansion.ts](../../packages/desktop/src/main/custom-command-expansion.ts) · [custom-command-shell.ts](../../packages/desktop/src/main/custom-command-shell.ts) · [custom-commands.ts](../../packages/desktop/src/main/custom-commands.ts) |
| `packages/desktop/src/renderer` | [CommandImportDialog.tsx](../../packages/desktop/src/renderer/CommandImportDialog.tsx) · [CommandSettings.tsx](../../packages/desktop/src/renderer/CommandSettings.tsx) · [command-import.css](../../packages/desktop/src/renderer/command-import.css) · [command-settings.css](../../packages/desktop/src/renderer/command-settings.css) |
| `packages/desktop/src/shared` | [command-import.ts](../../packages/desktop/src/shared/command-import.ts) · [custom-commands.ts](../../packages/desktop/src/shared/custom-commands.ts) |
| `packages/ui/src/components` | [command-suggestions.ts](../../packages/ui/src/components/command-suggestions.ts) |

### [上下文、压缩与媒体预算](context.md)

| 目录 | 文件 |
| --- | --- |
| `packages/ai/src/utils` | [context-breakdown.ts](../../packages/ai/src/utils/context-breakdown.ts) · [estimate.ts](../../packages/ai/src/utils/estimate.ts) · [media-policy.ts](../../packages/ai/src/utils/media-policy.ts) |
| `packages/coding-agent/src/core` | [compaction-utils.ts](../../packages/coding-agent/src/core/compaction-utils.ts) · [compaction.ts](../../packages/coding-agent/src/core/compaction.ts) · [image-limits.ts](../../packages/coding-agent/src/core/image-limits.ts) · [images.ts](../../packages/coding-agent/src/core/images.ts) · [microcompact.ts](../../packages/coding-agent/src/core/microcompact.ts) |

### [开发启动与构建链路](development.md)

| 目录 | 文件 |
| --- | --- |
| `scripts` | [build.mjs](../../scripts/build.mjs) · [desktop-build.d.mts](../../scripts/desktop-build.d.mts) · [desktop-build.mjs](../../scripts/desktop-build.mjs) · [dev-process.ts](../../scripts/dev-process.ts) · [dev.mjs](../../scripts/dev.mjs) |

### [错误、性能与用量计量](diagnostics.md)

| 目录 | 文件 |
| --- | --- |
| `packages/ai/src/utils` | [cost.ts](../../packages/ai/src/utils/cost.ts) · [diagnostics.ts](../../packages/ai/src/utils/diagnostics.ts) · [error-body.ts](../../packages/ai/src/utils/error-body.ts) · [model-performance.ts](../../packages/ai/src/utils/model-performance.ts) · [redact-error.ts](../../packages/ai/src/utils/redact-error.ts) |
| `packages/coding-agent/src/core` | [model-performance.ts](../../packages/coding-agent/src/core/model-performance.ts) |
| `packages/desktop/src/main` | [error-log.ts](../../packages/desktop/src/main/error-log.ts) · [performance-diagnostics.ts](../../packages/desktop/src/main/performance-diagnostics.ts) |
| `packages/desktop/src/renderer` | [ModelPerformance.tsx](../../packages/desktop/src/renderer/ModelPerformance.tsx) · [error-log.ts](../../packages/desktop/src/renderer/error-log.ts) · [performance-diagnostics.ts](../../packages/desktop/src/renderer/performance-diagnostics.ts) · [user-error.ts](../../packages/desktop/src/renderer/user-error.ts) |
| `packages/desktop/src/shared` | [performance-diagnostics.ts](../../packages/desktop/src/shared/performance-diagnostics.ts) |
| `packages/ui/src` | [user-error.ts](../../packages/ui/src/user-error.ts) |
| `packages/ui/src/components` | [FlipMetricValue.tsx](../../packages/ui/src/components/FlipMetricValue.tsx) · [ModelWaitNotice.tsx](../../packages/ui/src/components/ModelWaitNotice.tsx) |

### [对话事实、History Worker 与懒加载](history.md)

| 目录 | 文件 |
| --- | --- |
| `packages/coding-agent/src/core` | [read-file-bounded.ts](../../packages/coding-agent/src/core/read-file-bounded.ts) · [record-validation.ts](../../packages/coding-agent/src/core/record-validation.ts) · [session-manager.ts](../../packages/coding-agent/src/core/session-manager.ts) · [session-state.ts](../../packages/coding-agent/src/core/session-state.ts) · [transcript-store.ts](../../packages/coding-agent/src/core/transcript-store.ts) |
| `packages/desktop/src/main` | [history-index.ts](../../packages/desktop/src/main/history-index.ts) · [history-performance.ts](../../packages/desktop/src/main/history-performance.ts) · [history-storage.ts](../../packages/desktop/src/main/history-storage.ts) · [history-worker.ts](../../packages/desktop/src/main/history-worker.ts) · [transcript-copy.ts](../../packages/desktop/src/main/transcript-copy.ts) · [transcript-schema.ts](../../packages/desktop/src/main/transcript-schema.ts) · [transcript-v2.ts](../../packages/desktop/src/main/transcript-v2.ts) |
| `packages/ui/src/components` | [ConversationHistory.tsx](../../packages/ui/src/components/ConversationHistory.tsx) |
| `scripts` | [repair-sessions.ts](../../scripts/repair-sessions.ts) |

### [输入、附件、引用与发送队列](input.md)

| 目录 | 文件 |
| --- | --- |
| `packages/coding-agent/src/core` | [input.ts](../../packages/coding-agent/src/core/input.ts) · [markdown-code.ts](../../packages/coding-agent/src/core/markdown-code.ts) · [mentions.ts](../../packages/coding-agent/src/core/mentions.ts) |
| `packages/desktop/src/main` | [attachments.ts](../../packages/desktop/src/main/attachments.ts) · [draft-store.ts](../../packages/desktop/src/main/draft-store.ts) · [input-queue.ts](../../packages/desktop/src/main/input-queue.ts) · [session-references.ts](../../packages/desktop/src/main/session-references.ts) |
| `packages/desktop/src/renderer` | [FileCommentEditor.tsx](../../packages/desktop/src/renderer/FileCommentEditor.tsx) · [composer-context.ts](../../packages/desktop/src/renderer/composer-context.ts) · [file-comments.ts](../../packages/desktop/src/renderer/file-comments.ts) · [file-gutter.ts](../../packages/desktop/src/renderer/file-gutter.ts) |
| `packages/ui/src` | [conversation-selections.ts](../../packages/ui/src/conversation-selections.ts) |
| `packages/ui/src/components` | [ConversationQueuePanel.tsx](../../packages/ui/src/components/ConversationQueuePanel.tsx) · [ConversationSelections.tsx](../../packages/ui/src/components/ConversationSelections.tsx) · [InputContext.tsx](../../packages/ui/src/components/InputContext.tsx) · [InputNotice.tsx](../../packages/ui/src/components/InputNotice.tsx) · [MentionEditor.tsx](../../packages/ui/src/components/MentionEditor.tsx) · [Reference.tsx](../../packages/ui/src/components/Reference.tsx) · [editor-history.ts](../../packages/ui/src/components/editor-history.ts) · [file-mention-query.ts](../../packages/ui/src/components/file-mention-query.ts) · [prompt-history.ts](../../packages/ui/src/components/prompt-history.ts) · [session-suggestions.ts](../../packages/ui/src/components/session-suggestions.ts) · [skill-suggestions.ts](../../packages/ui/src/components/skill-suggestions.ts) |

### [记忆的读取、提取、整合与恢复](memory.md)

| 目录 | 文件 |
| --- | --- |
| `packages/desktop/src/main/memory` | [ad-hoc-instructions.ts](../../packages/desktop/src/main/memory/ad-hoc-instructions.ts) · [consolidation-instructions.ts](../../packages/desktop/src/main/memory/consolidation-instructions.ts) · [evidence.ts](../../packages/desktop/src/main/memory/evidence.ts) · [extraction-instructions.ts](../../packages/desktop/src/main/memory/extraction-instructions.ts) · [long-memory.ts](../../packages/desktop/src/main/memory/long-memory.ts) · [prompts.ts](../../packages/desktop/src/main/memory/prompts.ts) · [runner.ts](../../packages/desktop/src/main/memory/runner.ts) · [short-memory.ts](../../packages/desktop/src/main/memory/short-memory.ts) · [workspace.ts](../../packages/desktop/src/main/memory/workspace.ts) |
| `packages/desktop/src/renderer` | [MemorySettings.tsx](../../packages/desktop/src/renderer/MemorySettings.tsx) · [memory-settings.css](../../packages/desktop/src/renderer/memory-settings.css) |
| `packages/desktop/src/shared` | [memory.ts](../../packages/desktop/src/shared/memory.ts) |

### [消息如何变成模型请求](model-protocols.md)

| 目录 | 文件 |
| --- | --- |
| `packages/ai/src` | [index.ts](../../packages/ai/src/index.ts) · [stream.ts](../../packages/ai/src/stream.ts) · [types.ts](../../packages/ai/src/types.ts) |
| `packages/ai/src/api` | [anthropic-messages.ts](../../packages/ai/src/api/anthropic-messages.ts) · [github-copilot-headers.ts](../../packages/ai/src/api/github-copilot-headers.ts) · [openai-completions.ts](../../packages/ai/src/api/openai-completions.ts) · [openai-responses.ts](../../packages/ai/src/api/openai-responses.ts) · [responses-cache.ts](../../packages/ai/src/api/responses-cache.ts) · [responses-events.ts](../../packages/ai/src/api/responses-events.ts) · [transform-messages.ts](../../packages/ai/src/api/transform-messages.ts) |
| `packages/ai/src/utils` | [event-stream.ts](../../packages/ai/src/utils/event-stream.ts) · [headers.ts](../../packages/ai/src/utils/headers.ts) · [json-parse.ts](../../packages/ai/src/utils/json-parse.ts) · [provider-cache.ts](../../packages/ai/src/utils/provider-cache.ts) · [sanitize-unicode.ts](../../packages/ai/src/utils/sanitize-unicode.ts) · [text.ts](../../packages/ai/src/utils/text.ts) · [transcript.ts](../../packages/ai/src/utils/transcript.ts) |

### [ChatGPT 登录与令牌生命周期](openai-auth.md)

| 目录 | 文件 |
| --- | --- |
| `packages/ai/src/auth` | [openai-chatgpt.ts](../../packages/ai/src/auth/openai-chatgpt.ts) |
| `packages/desktop/src/main` | [chatgpt-auth.ts](../../packages/desktop/src/main/chatgpt-auth.ts) |
| `packages/desktop/src/renderer` | [ChatGPTConnection.tsx](../../packages/desktop/src/renderer/ChatGPTConnection.tsx) |

### [OpenAI Responses WebSocket 与增量续接](openai-websocket.md)

| 目录 | 文件 |
| --- | --- |
| `packages/ai/src/api` | [responses-session.ts](../../packages/ai/src/api/responses-session.ts) |
| `packages/desktop/src/main` | [responses-proxy.ts](../../packages/desktop/src/main/responses-proxy.ts) |

### [发行产物、原生模块与平台限制](packaging.md)

| 目录 | 文件 |
| --- | --- |
| `scripts` | [app-icon.mjs](../../scripts/app-icon.mjs) · [build-native.mjs](../../scripts/build-native.mjs) · [prepare-terminal.ts](../../scripts/prepare-terminal.ts) |

### [标签身份、完整视图与原生面板](panes.md)

| 目录 | 文件 |
| --- | --- |
| `packages/desktop/src/main` | [browser-url.ts](../../packages/desktop/src/main/browser-url.ts) · [pane-services.ts](../../packages/desktop/src/main/pane-services.ts) |
| `packages/desktop/src/renderer` | [BrowserPane.tsx](../../packages/desktop/src/renderer/BrowserPane.tsx) · [PaneFullViewControls.tsx](../../packages/desktop/src/renderer/PaneFullViewControls.tsx) · [PaneLauncher.tsx](../../packages/desktop/src/renderer/PaneLauncher.tsx) · [PaneTabIcon.tsx](../../packages/desktop/src/renderer/PaneTabIcon.tsx) · [PaneTabOverview.tsx](../../packages/desktop/src/renderer/PaneTabOverview.tsx) · [PaneTabs.tsx](../../packages/desktop/src/renderer/PaneTabs.tsx) · [RightPane.tsx](../../packages/desktop/src/renderer/RightPane.tsx) · [browser-address.ts](../../packages/desktop/src/renderer/browser-address.ts) · [browser-pane.css](../../packages/desktop/src/renderer/browser-pane.css) · [pane-full-view.ts](../../packages/desktop/src/renderer/pane-full-view.ts) · [pane-store.ts](../../packages/desktop/src/renderer/pane-store.ts) · [pane-tabs.css](../../packages/desktop/src/renderer/pane-tabs.css) |

### [文件树、预览格式、备注与交付卡片](previews.md)

| 目录 | 文件 |
| --- | --- |
| `packages/desktop/src/main` | [file-actions.ts](../../packages/desktop/src/main/file-actions.ts) · [file-preview.ts](../../packages/desktop/src/main/file-preview.ts) · [local-file-path.ts](../../packages/desktop/src/main/local-file-path.ts) · [path-bounds.ts](../../packages/desktop/src/main/path-bounds.ts) · [preview-files.ts](../../packages/desktop/src/main/preview-files.ts) · [preview-pdf-export.ts](../../packages/desktop/src/main/preview-pdf-export.ts) · [preview-print-host.ts](../../packages/desktop/src/main/preview-print-host.ts) · [workspace-files.ts](../../packages/desktop/src/main/workspace-files.ts) |
| `packages/desktop/src/renderer` | [DirectoryMenuItems.tsx](../../packages/desktop/src/renderer/DirectoryMenuItems.tsx) · [DocxPreview.tsx](../../packages/desktop/src/renderer/DocxPreview.tsx) · [FileManagerPane.tsx](../../packages/desktop/src/renderer/FileManagerPane.tsx) · [FilePane.tsx](../../packages/desktop/src/renderer/FilePane.tsx) · [FilePreviewBoundary.tsx](../../packages/desktop/src/renderer/FilePreviewBoundary.tsx) · [LegacyDocPreview.tsx](../../packages/desktop/src/renderer/LegacyDocPreview.tsx) · [OfficePreview.tsx](../../packages/desktop/src/renderer/OfficePreview.tsx) · [PdfPreview.css](../../packages/desktop/src/renderer/PdfPreview.css) · [PdfPreview.tsx](../../packages/desktop/src/renderer/PdfPreview.tsx) · [PptxPreview.css](../../packages/desktop/src/renderer/PptxPreview.css) · [PptxPreview.tsx](../../packages/desktop/src/renderer/PptxPreview.tsx) · [PreviewEditorButton.tsx](../../packages/desktop/src/renderer/PreviewEditorButton.tsx) · [PreviewHeader.tsx](../../packages/desktop/src/renderer/PreviewHeader.tsx) · [markdown-image.ts](../../packages/desktop/src/renderer/markdown-image.ts) · [office-preview-model.ts](../../packages/desktop/src/renderer/office-preview-model.ts) · [pdf-assets.ts](../../packages/desktop/src/renderer/pdf-assets.ts) · [pdf-range.ts](../../packages/desktop/src/renderer/pdf-range.ts) · [pdf-zoom.ts](../../packages/desktop/src/renderer/pdf-zoom.ts) · [preview-breadcrumb.ts](../../packages/desktop/src/renderer/preview-breadcrumb.ts) · [preview-loader.ts](../../packages/desktop/src/renderer/preview-loader.ts) · [preview-services.ts](../../packages/desktop/src/renderer/preview-services.ts) · [use-docx-preview-fit.ts](../../packages/desktop/src/renderer/use-docx-preview-fit.ts) · [use-workspace.ts](../../packages/desktop/src/renderer/use-workspace.ts) |
| `packages/desktop/src/renderer/presentation` | [controls.ts](../../packages/desktop/src/renderer/presentation/controls.ts) · [element-model.ts](../../packages/desktop/src/renderer/presentation/element-model.ts) · [export.ts](../../packages/desktop/src/renderer/presentation/export.ts) · [pptx-engine.ts](../../packages/desktop/src/renderer/presentation/pptx-engine.ts) · [print-export.ts](../../packages/desktop/src/renderer/presentation/print-export.ts) · [reference.ts](../../packages/desktop/src/renderer/presentation/reference.ts) · [types.ts](../../packages/desktop/src/renderer/presentation/types.ts) |
| `packages/desktop/src/renderer/workspace-file-tree` | [FileTreeRow.tsx](../../packages/desktop/src/renderer/workspace-file-tree/FileTreeRow.tsx) · [WorkspaceFileTree.tsx](../../packages/desktop/src/renderer/workspace-file-tree/WorkspaceFileTree.tsx) · [constants.ts](../../packages/desktop/src/renderer/workspace-file-tree/constants.ts) · [file-tree.css](../../packages/desktop/src/renderer/workspace-file-tree/file-tree.css) · [helpers.ts](../../packages/desktop/src/renderer/workspace-file-tree/helpers.ts) · [hierarchy-guides.ts](../../packages/desktop/src/renderer/workspace-file-tree/hierarchy-guides.ts) · [model.ts](../../packages/desktop/src/renderer/workspace-file-tree/model.ts) · [refresh-directories.ts](../../packages/desktop/src/renderer/workspace-file-tree/refresh-directories.ts) · [services.ts](../../packages/desktop/src/renderer/workspace-file-tree/services.ts) · [sticky-folders.ts](../../packages/desktop/src/renderer/workspace-file-tree/sticky-folders.ts) · [use-row-drag.ts](../../packages/desktop/src/renderer/workspace-file-tree/use-row-drag.ts) · [use-tree-data.ts](../../packages/desktop/src/renderer/workspace-file-tree/use-tree-data.ts) · [use-tree-rows.ts](../../packages/desktop/src/renderer/workspace-file-tree/use-tree-rows.ts) · [use-tree-watchers.ts](../../packages/desktop/src/renderer/workspace-file-tree/use-tree-watchers.ts) |
| `packages/desktop/src/shared` | [workspace-files.ts](../../packages/desktop/src/shared/workspace-files.ts) |
| `packages/ui/src` | [code-preview.ts](../../packages/ui/src/code-preview.ts) · [file-citation.ts](../../packages/ui/src/file-citation.ts) · [file-icon-names.json](../../packages/ui/src/file-icon-names.json) · [file-icons.ts](../../packages/ui/src/file-icons.ts) · [link-target.ts](../../packages/ui/src/link-target.ts) · [patch-preview.ts](../../packages/ui/src/patch-preview.ts) · [preview-cards.css](../../packages/ui/src/preview-cards.css) |
| `packages/ui/src/components` | [AssistantPreviewCards.tsx](../../packages/ui/src/components/AssistantPreviewCards.tsx) · [OpenFileButton.tsx](../../packages/ui/src/components/OpenFileButton.tsx) · [tool-input-preview.ts](../../packages/ui/src/components/tool-input-preview.ts) |
| `packages/ui/src/preview` | [assistant-file-references.ts](../../packages/ui/src/preview/assistant-file-references.ts) · [assistant-path-quotes.ts](../../packages/ui/src/preview/assistant-path-quotes.ts) · [assistant-preview-cards.ts](../../packages/ui/src/preview/assistant-preview-cards.ts) · [assistant-preview-validation.ts](../../packages/ui/src/preview/assistant-preview-validation.ts) · [media-preview.ts](../../packages/ui/src/preview/media-preview.ts) · [path.ts](../../packages/ui/src/preview/path.ts) · [preview-artifacts.ts](../../packages/ui/src/preview/preview-artifacts.ts) · [preview-file-path.ts](../../packages/ui/src/preview/preview-file-path.ts) · [preview-lifecycle.ts](../../packages/ui/src/preview/preview-lifecycle.ts) |
| `scripts` | [verify-preview-assets.mjs](../../scripts/verify-preview-assets.mjs) · [verify-preview-sidebar.mjs](../../scripts/verify-preview-sidebar.mjs) |

### [项目、任务分组与 Git 工作树](projects.md)

| 目录 | 文件 |
| --- | --- |
| `packages/desktop/src/main` | [default-file-open.ts](../../packages/desktop/src/main/default-file-open.ts) · [editor-definitions.ts](../../packages/desktop/src/main/editor-definitions.ts) · [editors.ts](../../packages/desktop/src/main/editors.ts) · [project-picker.ts](../../packages/desktop/src/main/project-picker.ts) · [task-groups.ts](../../packages/desktop/src/main/task-groups.ts) · [workspace-directory.ts](../../packages/desktop/src/main/workspace-directory.ts) · [worktrees.ts](../../packages/desktop/src/main/worktrees.ts) |
| `packages/desktop/src/renderer` | [DraftProjectPicker.tsx](../../packages/desktop/src/renderer/DraftProjectPicker.tsx) · [SortableProjects.tsx](../../packages/desktop/src/renderer/SortableProjects.tsx) · [TaskGroupRow.tsx](../../packages/desktop/src/renderer/TaskGroupRow.tsx) · [TaskGroupVirtualList.tsx](../../packages/desktop/src/renderer/TaskGroupVirtualList.tsx) · [TaskGroups.tsx](../../packages/desktop/src/renderer/TaskGroups.tsx) · [WorkspaceEditorButton.tsx](../../packages/desktop/src/renderer/WorkspaceEditorButton.tsx) · [WorktreeSettings.tsx](../../packages/desktop/src/renderer/WorktreeSettings.tsx) · [editor-buttons.css](../../packages/desktop/src/renderer/editor-buttons.css) · [editor-preference-storage.ts](../../packages/desktop/src/renderer/editor-preference-storage.ts) · [editor-preference.ts](../../packages/desktop/src/renderer/editor-preference.ts) · [task-group-colors.tsx](../../packages/desktop/src/renderer/task-group-colors.tsx) · [task-group-drag.ts](../../packages/desktop/src/renderer/task-group-drag.ts) · [task-group-expansion.ts](../../packages/desktop/src/renderer/task-group-expansion.ts) |
| `packages/desktop/src/shared` | [editors.ts](../../packages/desktop/src/shared/editors.ts) · [task-groups.ts](../../packages/desktop/src/shared/task-groups.ts) |

### [提供商、模型配置与推理级别](providers.md)

| 目录 | 文件 |
| --- | --- |
| `packages/ai/src/api` | [constrained-sampling.ts](../../packages/ai/src/api/constrained-sampling.ts) · [simple-options.ts](../../packages/ai/src/api/simple-options.ts) |
| `packages/ai/src/providers` | [catalog.json](../../packages/ai/src/providers/catalog.json) · [discovery.ts](../../packages/ai/src/providers/discovery.ts) · [registry.ts](../../packages/ai/src/providers/registry.ts) |
| `packages/ai/src/utils` | [provider-env.ts](../../packages/ai/src/utils/provider-env.ts) · [reasoning.ts](../../packages/ai/src/utils/reasoning.ts) |
| `packages/ai/src/utils/option-map` | [compiler.ts](../../packages/ai/src/utils/option-map/compiler.ts) · [evaluator.ts](../../packages/ai/src/utils/option-map/evaluator.ts) · [parser.ts](../../packages/ai/src/utils/option-map/parser.ts) · [tokenizer.ts](../../packages/ai/src/utils/option-map/tokenizer.ts) · [types.ts](../../packages/ai/src/utils/option-map/types.ts) |
| `packages/coding-agent/src/core` | [model-runtime.ts](../../packages/coding-agent/src/core/model-runtime.ts) |
| `packages/desktop/src/main` | [model-runtime-config.ts](../../packages/desktop/src/main/model-runtime-config.ts) |
| `packages/desktop/src/renderer` | [ModelConfigAdvanced.tsx](../../packages/desktop/src/renderer/ModelConfigAdvanced.tsx) · [ModelConfigDialog.tsx](../../packages/desktop/src/renderer/ModelConfigDialog.tsx) · [ProviderApiFormatSelect.tsx](../../packages/desktop/src/renderer/ProviderApiFormatSelect.tsx) · [ProviderCredentialInput.tsx](../../packages/desktop/src/renderer/ProviderCredentialInput.tsx) · [ProviderHeadingActions.tsx](../../packages/desktop/src/renderer/ProviderHeadingActions.tsx) · [ProviderLogo.tsx](../../packages/desktop/src/renderer/ProviderLogo.tsx) · [ReasoningLevelEditor.tsx](../../packages/desktop/src/renderer/ReasoningLevelEditor.tsx) |

### [结构化提问](questions.md)

| 目录 | 文件 |
| --- | --- |
| `packages/desktop/src/main` | [user-questions.ts](../../packages/desktop/src/main/user-questions.ts) |
| `packages/desktop/src/renderer` | [UserQuestionCard.tsx](../../packages/desktop/src/renderer/UserQuestionCard.tsx) |
| `packages/ui/src/components` | [AskQuestionToolBlock.tsx](../../packages/ui/src/components/AskQuestionToolBlock.tsx) · [user-question-presentation.ts](../../packages/ui/src/components/user-question-presentation.ts) |

### [快速对话的临时会话与窗口协调](quick-chat.md)

| 目录 | 文件 |
| --- | --- |
| `packages/desktop/native` | [copy-selection.m](../../packages/desktop/native/copy-selection.m) · [quick-chat-focus.m](../../packages/desktop/native/quick-chat-focus.m) |
| `packages/desktop/src/main` | [mac-quick-chat-capture.ts](../../packages/desktop/src/main/mac-quick-chat-capture.ts) · [mac-quick-chat-focus.ts](../../packages/desktop/src/main/mac-quick-chat-focus.ts) · [quick-chat-attachments.ts](../../packages/desktop/src/main/quick-chat-attachments.ts) · [quick-chat-capture.ts](../../packages/desktop/src/main/quick-chat-capture.ts) · [quick-chat-host.ts](../../packages/desktop/src/main/quick-chat-host.ts) · [quick-chat-presentation.ts](../../packages/desktop/src/main/quick-chat-presentation.ts) · [quick-chat-prompt.ts](../../packages/desktop/src/main/quick-chat-prompt.ts) · [quick-chat-source-icons.ts](../../packages/desktop/src/main/quick-chat-source-icons.ts) · [quick-chat-timing.ts](../../packages/desktop/src/main/quick-chat-timing.ts) · [quick-chat-window.ts](../../packages/desktop/src/main/quick-chat-window.ts) |
| `packages/desktop/src/preload` | [quick-chat.ts](../../packages/desktop/src/preload/quick-chat.ts) |
| `packages/desktop/src/renderer` | [QuickChat.tsx](../../packages/desktop/src/renderer/QuickChat.tsx) · [QuickChatAttachment.tsx](../../packages/desktop/src/renderer/QuickChatAttachment.tsx) · [QuickChatConversation.tsx](../../packages/desktop/src/renderer/QuickChatConversation.tsx) · [QuickChatSettings.tsx](../../packages/desktop/src/renderer/QuickChatSettings.tsx) · [quick-chat-attachments.ts](../../packages/desktop/src/renderer/quick-chat-attachments.ts) · [quick-chat-main.tsx](../../packages/desktop/src/renderer/quick-chat-main.tsx) · [quick-chat.css](../../packages/desktop/src/renderer/quick-chat.css) · [quick-chat.html](../../packages/desktop/src/renderer/quick-chat.html) |
| `packages/desktop/src/shared` | [quick-chat-settings.ts](../../packages/desktop/src/shared/quick-chat-settings.ts) · [quick-chat.ts](../../packages/desktop/src/shared/quick-chat.ts) |

### [发送失败、超时与恢复](recovery.md)

| 目录 | 文件 |
| --- | --- |
| `packages/ai/src/utils` | [abort.ts](../../packages/ai/src/utils/abort.ts) · [guard-model-stream.ts](../../packages/ai/src/utils/guard-model-stream.ts) · [model-retry.ts](../../packages/ai/src/utils/model-retry.ts) · [overflow.ts](../../packages/ai/src/utils/overflow.ts) · [provider-retry.ts](../../packages/ai/src/utils/provider-retry.ts) · [retry.ts](../../packages/ai/src/utils/retry.ts) · [stream-idle-timeout.ts](../../packages/ai/src/utils/stream-idle-timeout.ts) |
| `packages/coding-agent/src/core` | [http-idle-timeout.ts](../../packages/coding-agent/src/core/http-idle-timeout.ts) · [streaming-tool-journal.ts](../../packages/coding-agent/src/core/streaming-tool-journal.ts) |

### [流式渲染、Markdown 与阅读位置](rendering.md)

| 目录 | 文件 |
| --- | --- |
| `packages/desktop/src/main` | [event-batcher.ts](../../packages/desktop/src/main/event-batcher.ts) · [projection.ts](../../packages/desktop/src/main/projection.ts) · [task-notifications.ts](../../packages/desktop/src/main/task-notifications.ts) |
| `packages/desktop/src/renderer` | [SessionConversation.tsx](../../packages/desktop/src/renderer/SessionConversation.tsx) · [SidebarSections.tsx](../../packages/desktop/src/renderer/SidebarSections.tsx) · [SidebarTaskList.tsx](../../packages/desktop/src/renderer/SidebarTaskList.tsx) · [SidebarTaskRow.tsx](../../packages/desktop/src/renderer/SidebarTaskRow.tsx) · [TaskListHeader.tsx](../../packages/desktop/src/renderer/TaskListHeader.tsx) · [WindowChrome.tsx](../../packages/desktop/src/renderer/WindowChrome.tsx) · [appearance.ts](../../packages/desktop/src/renderer/appearance.ts) · [sidebar-task-model.ts](../../packages/desktop/src/renderer/sidebar-task-model.ts) · [task-notification-sound.ts](../../packages/desktop/src/renderer/task-notification-sound.ts) · [workbench.css](../../packages/desktop/src/renderer/workbench.css) |
| `packages/desktop/src/shared` | [event-batches.ts](../../packages/desktop/src/shared/event-batches.ts) |
| `packages/ui/src` | [appearance.ts](../../packages/ui/src/appearance.ts) · [code-language.ts](../../packages/ui/src/code-language.ts) · [index.ts](../../packages/ui/src/index.ts) · [markdown-fence.ts](../../packages/ui/src/markdown-fence.ts) · [markdown-link-nodes.ts](../../packages/ui/src/markdown-link-nodes.ts) · [reading-position.ts](../../packages/ui/src/reading-position.ts) · [reducer.ts](../../packages/ui/src/reducer.ts) · [styles.css](../../packages/ui/src/styles.css) · [tokens.css](../../packages/ui/src/tokens.css) · [types.ts](../../packages/ui/src/types.ts) |
| `packages/ui/src/components` | [CompactionDivider.tsx](../../packages/ui/src/components/CompactionDivider.tsx) · [Conversation.tsx](../../packages/ui/src/components/Conversation.tsx) · [DraftGreeting.tsx](../../packages/ui/src/components/DraftGreeting.tsx) · [Markdown.tsx](../../packages/ui/src/components/Markdown.tsx) · [MarkdownActions.tsx](../../packages/ui/src/components/MarkdownActions.tsx) · [MarkdownCode.tsx](../../packages/ui/src/components/MarkdownCode.tsx) · [MarkdownImage.tsx](../../packages/ui/src/components/MarkdownImage.tsx) · [MarkdownLink.tsx](../../packages/ui/src/components/MarkdownLink.tsx) · [MarkdownTable.tsx](../../packages/ui/src/components/MarkdownTable.tsx) · [MermaidBlock.tsx](../../packages/ui/src/components/MermaidBlock.tsx) · [MessageActions.tsx](../../packages/ui/src/components/MessageActions.tsx) · [Notice.tsx](../../packages/ui/src/components/Notice.tsx) · [QueuedSummaryContent.tsx](../../packages/ui/src/components/QueuedSummaryContent.tsx) · [SortableList.tsx](../../packages/ui/src/components/SortableList.tsx) · [StreamEntrance.tsx](../../packages/ui/src/components/StreamEntrance.tsx) · [SuggestionOptions.tsx](../../packages/ui/src/components/SuggestionOptions.tsx) · [TaskTitleOverflowText.tsx](../../packages/ui/src/components/TaskTitleOverflowText.tsx) · [ToolBlock.tsx](../../packages/ui/src/components/ToolBlock.tsx) · [ToolFailure.tsx](../../packages/ui/src/components/ToolFailure.tsx) · [ToolGroup.tsx](../../packages/ui/src/components/ToolGroup.tsx) · [ToolLayout.tsx](../../packages/ui/src/components/ToolLayout.tsx) · [ToolOutput.tsx](../../packages/ui/src/components/ToolOutput.tsx) · [UserMessageBody.tsx](../../packages/ui/src/components/UserMessageBody.tsx) · [markdown-configuration.ts](../../packages/ui/src/components/markdown-configuration.ts) · [markdown-math.ts](../../packages/ui/src/components/markdown-math.ts) · [markdown-table-text.ts](../../packages/ui/src/components/markdown-table-text.ts) · [mermaid-budget.ts](../../packages/ui/src/components/mermaid-budget.ts) · [mermaid-language.ts](../../packages/ui/src/components/mermaid-language.ts) · [tool-presentation.ts](../../packages/ui/src/components/tool-presentation.ts) · [use-prefers-reduced-motion.ts](../../packages/ui/src/components/use-prefers-reduced-motion.ts) · [use-selection-stable-value.ts](../../packages/ui/src/components/use-selection-stable-value.ts) |

### [指令、技能与系统提示加载](resources.md)

| 目录 | 文件 |
| --- | --- |
| `packages/coding-agent/src/core` | [resources.ts](../../packages/coding-agent/src/core/resources.ts) · [system-prompt.ts](../../packages/coding-agent/src/core/system-prompt.ts) |
| `packages/desktop/src/main` | [desktop-prompt.ts](../../packages/desktop/src/main/desktop-prompt.ts) |
| `packages/desktop/src/renderer` | [ResourceSettings.tsx](../../packages/desktop/src/renderer/ResourceSettings.tsx) |

### [Git 审查、工具快照与文件回退](review.md)

| 目录 | 文件 |
| --- | --- |
| `packages/desktop/src/main` | [diff-worker.ts](../../packages/desktop/src/main/diff-worker.ts) · [file-changes.ts](../../packages/desktop/src/main/file-changes.ts) · [file-rewind.ts](../../packages/desktop/src/main/file-rewind.ts) · [git-review.ts](../../packages/desktop/src/main/git-review.ts) |
| `packages/desktop/src/renderer` | [ChangesPane.tsx](../../packages/desktop/src/renderer/ChangesPane.tsx) · [DiffsWorkerPool.tsx](../../packages/desktop/src/renderer/DiffsWorkerPool.tsx) · [ReviewPane.tsx](../../packages/desktop/src/renderer/ReviewPane.tsx) · [diffs.worker.ts](../../packages/desktop/src/renderer/diffs.worker.ts) · [review-pane.css](../../packages/desktop/src/renderer/review-pane.css) |
| `packages/desktop/src/shared` | [review.ts](../../packages/desktop/src/shared/review.ts) |
| `packages/ui/src` | [review-diff.ts](../../packages/ui/src/review-diff.ts) |
| `packages/ui/src/components` | [ChangedFiles.tsx](../../packages/ui/src/components/ChangedFiles.tsx) · [DiffView.tsx](../../packages/ui/src/components/DiffView.tsx) · [FileRewindConflictDialog.tsx](../../packages/ui/src/components/FileRewindConflictDialog.tsx) · [ReviewDiffViewer.tsx](../../packages/ui/src/components/ReviewDiffViewer.tsx) · [ToolDiff.tsx](../../packages/ui/src/components/ToolDiff.tsx) |

### [Electron 启动与进程边界](runtime.md)

| 目录 | 文件 |
| --- | --- |
| `packages/desktop/src/main` | [index.ts](../../packages/desktop/src/main/index.ts) · [load-renderer.ts](../../packages/desktop/src/main/load-renderer.ts) |
| `packages/desktop/src/preload` | [index.ts](../../packages/desktop/src/preload/index.ts) |
| `packages/desktop/src/renderer` | [App.tsx](../../packages/desktop/src/renderer/App.tsx) · [AppBoundary.tsx](../../packages/desktop/src/renderer/AppBoundary.tsx) · [SettingsHelp.tsx](../../packages/desktop/src/renderer/SettingsHelp.tsx) · [SettingsPage.tsx](../../packages/desktop/src/renderer/SettingsPage.tsx) · [SettingsSelect.tsx](../../packages/desktop/src/renderer/SettingsSelect.tsx) · [app-state.ts](../../packages/desktop/src/renderer/app-state.ts) · [env.d.ts](../../packages/desktop/src/renderer/env.d.ts) · [index.html](../../packages/desktop/src/renderer/index.html) · [main.tsx](../../packages/desktop/src/renderer/main.tsx) · [store.ts](../../packages/desktop/src/renderer/store.ts) · [unwrap.ts](../../packages/desktop/src/renderer/unwrap.ts) |
| `packages/desktop/src/shared` | [bridge.ts](../../packages/desktop/src/shared/bridge.ts) · [config.ts](../../packages/desktop/src/shared/config.ts) |

### [SDK 装配与扩展边界](sdk.md)

| 目录 | 文件 |
| --- | --- |
| `examples` | [coding-session.ts](../../examples/coding-session.ts) |
| `packages/coding-agent/src` | [index.ts](../../packages/coding-agent/src/index.ts) |
| `packages/coding-agent/src/core` | [sdk.ts](../../packages/coding-agent/src/core/sdk.ts) · [settings-manager.ts](../../packages/coding-agent/src/core/settings-manager.ts) · [types.ts](../../packages/coding-agent/src/core/types.ts) |

### [任务、正文、文件和 Diff 查找](search.md)

| 目录 | 文件 |
| --- | --- |
| `packages/desktop/src/main` | [workspace-file-searches.ts](../../packages/desktop/src/main/workspace-file-searches.ts) |
| `packages/desktop/src/renderer` | [FileSearchStatus.tsx](../../packages/desktop/src/renderer/FileSearchStatus.tsx) · [HighlightedMatchText.tsx](../../packages/desktop/src/renderer/HighlightedMatchText.tsx) · [TaskSearchDialog.tsx](../../packages/desktop/src/renderer/TaskSearchDialog.tsx) · [task-search-history.ts](../../packages/desktop/src/renderer/task-search-history.ts) · [task-search-icons.ts](../../packages/desktop/src/renderer/task-search-icons.ts) · [task-search-model.ts](../../packages/desktop/src/renderer/task-search-model.ts) · [use-task-find.ts](../../packages/desktop/src/renderer/use-task-find.ts) · [use-workspace-file-search.ts](../../packages/desktop/src/renderer/use-workspace-file-search.ts) |
| `packages/desktop/src/shared` | [task-search.ts](../../packages/desktop/src/shared/task-search.ts) |
| `packages/ui/src` | [find.ts](../../packages/ui/src/find.ts) · [fuzzy-search.ts](../../packages/ui/src/fuzzy-search.ts) · [patch-find.ts](../../packages/ui/src/patch-find.ts) · [review-find.ts](../../packages/ui/src/review-find.ts) |
| `packages/ui/src/components` | [TaskFindBar.tsx](../../packages/ui/src/components/TaskFindBar.tsx) · [conversation-find.ts](../../packages/ui/src/components/conversation-find.ts) · [find-dom.ts](../../packages/ui/src/components/find-dom.ts) · [markdown-find.ts](../../packages/ui/src/components/markdown-find.ts) · [use-text-find.ts](../../packages/ui/src/components/use-text-find.ts) |

### [会话、任务与运行生命周期](sessions.md)

| 目录 | 文件 |
| --- | --- |
| `packages/coding-agent/src/core` | [agent-session.ts](../../packages/coding-agent/src/core/agent-session.ts) |
| `packages/desktop/src/main` | [session-activity.ts](../../packages/desktop/src/main/session-activity.ts) · [session-host.ts](../../packages/desktop/src/main/session-host.ts) · [session-title.ts](../../packages/desktop/src/main/session-title.ts) |
| `packages/desktop/src/renderer` | [ArchivedTasks.tsx](../../packages/desktop/src/renderer/ArchivedTasks.tsx) · [CapabilitySettings.tsx](../../packages/desktop/src/renderer/CapabilitySettings.tsx) · [SessionToolbar.tsx](../../packages/desktop/src/renderer/SessionToolbar.tsx) · [SideChatPane.tsx](../../packages/desktop/src/renderer/SideChatPane.tsx) · [TaskActivity.tsx](../../packages/desktop/src/renderer/TaskActivity.tsx) · [TaskMenu.tsx](../../packages/desktop/src/renderer/TaskMenu.tsx) · [TaskMenuItems.tsx](../../packages/desktop/src/renderer/TaskMenuItems.tsx) · [TaskViewMenu.tsx](../../packages/desktop/src/renderer/TaskViewMenu.tsx) |

### [快捷键路由、注册与焦点](shortcuts.md)

| 目录 | 文件 |
| --- | --- |
| `packages/desktop/src/main` | [shortcut-controller.ts](../../packages/desktop/src/main/shortcut-controller.ts) · [shortcut-defaults-migration.ts](../../packages/desktop/src/main/shortcut-defaults-migration.ts) · [shortcut-modifier.ts](../../packages/desktop/src/main/shortcut-modifier.ts) |
| `packages/desktop/src/renderer` | [ShortcutSettings.tsx](../../packages/desktop/src/renderer/ShortcutSettings.tsx) · [app-shortcuts.ts](../../packages/desktop/src/renderer/app-shortcuts.ts) · [composer-shortcuts.ts](../../packages/desktop/src/renderer/composer-shortcuts.ts) · [shortcut-context.ts](../../packages/desktop/src/renderer/shortcut-context.ts) · [shortcut-recording.ts](../../packages/desktop/src/renderer/shortcut-recording.ts) · [shortcut-settings-model.ts](../../packages/desktop/src/renderer/shortcut-settings-model.ts) · [use-dialog-dismiss.ts](../../packages/desktop/src/renderer/use-dialog-dismiss.ts) · [use-overlay-shortcut.ts](../../packages/desktop/src/renderer/use-overlay-shortcut.ts) · [use-stop-on-escape.ts](../../packages/desktop/src/renderer/use-stop-on-escape.ts) |
| `packages/desktop/src/shared` | [shortcuts.ts](../../packages/desktop/src/shared/shortcuts.ts) · [workspace-shortcuts.ts](../../packages/desktop/src/shared/workspace-shortcuts.ts) |

### [业务存储、凭据、generation 与清理](storage.md)

| 目录 | 文件 |
| --- | --- |
| `packages/desktop/src/main` | [state-migrations.ts](../../packages/desktop/src/main/state-migrations.ts) · [state-schema-v1.ts](../../packages/desktop/src/main/state-schema-v1.ts) · [state-store.ts](../../packages/desktop/src/main/state-store.ts) · [storage-cleanup.ts](../../packages/desktop/src/main/storage-cleanup.ts) · [storage-generation.ts](../../packages/desktop/src/main/storage-generation.ts) · [storage.ts](../../packages/desktop/src/main/storage.ts) · [task-state.ts](../../packages/desktop/src/main/task-state.ts) |
| `scripts` | [storage-migrate.ts](../../scripts/storage-migrate.ts) |
| `scripts/storage-migration` | [legacy-journal.ts](../../scripts/storage-migration/legacy-journal.ts) · [legacy-settings.ts](../../scripts/storage-migration/legacy-settings.ts) · [legacy.ts](../../scripts/storage-migration/legacy.ts) · [workflow.ts](../../scripts/storage-migration/workflow.ts) |

### [子智能体的配置、协议与邮箱](subagents.md)

| 目录 | 文件 |
| --- | --- |
| `packages/desktop/src/main/plugins/subagents` | [artifacts.ts](../../packages/desktop/src/main/plugins/subagents/artifacts.ts) · [built-in.ts](../../packages/desktop/src/main/plugins/subagents/built-in.ts) · [profiles.ts](../../packages/desktop/src/main/plugins/subagents/profiles.ts) · [prompts.ts](../../packages/desktop/src/main/plugins/subagents/prompts.ts) · [protocol.ts](../../packages/desktop/src/main/plugins/subagents/protocol.ts) · [runtime.ts](../../packages/desktop/src/main/plugins/subagents/runtime.ts) · [validation.ts](../../packages/desktop/src/main/plugins/subagents/validation.ts) |
| `packages/desktop/src/renderer` | [SubagentPane.tsx](../../packages/desktop/src/renderer/SubagentPane.tsx) · [SubagentSettings.tsx](../../packages/desktop/src/renderer/SubagentSettings.tsx) |
| `packages/desktop/src/shared` | [subagents.ts](../../packages/desktop/src/shared/subagents.ts) |
| `packages/ui/src/components` | [SubagentMessageToolBlock.tsx](../../packages/ui/src/components/SubagentMessageToolBlock.tsx) · [SubagentTaskToolBlock.tsx](../../packages/ui/src/components/SubagentTaskToolBlock.tsx) · [SubagentToolBlock.tsx](../../packages/ui/src/components/SubagentToolBlock.tsx) |

### [测试隔离、真实边界与清理](testing.md)

| 目录 | 文件 |
| --- | --- |
| `packages/desktop/src/main` | [automation.ts](../../packages/desktop/src/main/automation.ts) |
| `scripts` | [benchmark-history-worker.ts](../../scripts/benchmark-history-worker.ts) · [benchmark-lazy-restore.ts](../../scripts/benchmark-lazy-restore.ts) · [benchmark-storage-migration.ts](../../scripts/benchmark-storage-migration.ts) · [observe-desktop-tests.mjs](../../scripts/observe-desktop-tests.mjs) · [test-desktop.ts](../../scripts/test-desktop.ts) · [verify-file-manager-parity.mjs](../../scripts/verify-file-manager-parity.mjs) · [verify-task-list-parity.mjs](../../scripts/verify-task-list-parity.mjs) · [verify-test-cleanup.mjs](../../scripts/verify-test-cleanup.mjs) |

### [read、write、edit、bash 的实现](tools.md)

| 目录 | 文件 |
| --- | --- |
| `packages/coding-agent/src/core/tools` | [file-change.ts](../../packages/coding-agent/src/core/tools/file-change.ts) · [index.ts](../../packages/coding-agent/src/core/tools/index.ts) |
| `packages/coding-agent/src/core/tools/pi` | [bash.ts](../../packages/coding-agent/src/core/tools/pi/bash.ts) · [edit-diff.ts](../../packages/coding-agent/src/core/tools/pi/edit-diff.ts) · [edit.ts](../../packages/coding-agent/src/core/tools/pi/edit.ts) · [file-mutation-queue.ts](../../packages/coding-agent/src/core/tools/pi/file-mutation-queue.ts) · [file-read-state.ts](../../packages/coding-agent/src/core/tools/pi/file-read-state.ts) · [output-accumulator.ts](../../packages/coding-agent/src/core/tools/pi/output-accumulator.ts) · [path-utils.ts](../../packages/coding-agent/src/core/tools/pi/path-utils.ts) · [read.ts](../../packages/coding-agent/src/core/tools/pi/read.ts) · [text-range-reader.ts](../../packages/coding-agent/src/core/tools/pi/text-range-reader.ts) · [tool-definition-wrapper.ts](../../packages/coding-agent/src/core/tools/pi/tool-definition-wrapper.ts) · [truncate.ts](../../packages/coding-agent/src/core/tools/pi/truncate.ts) · [write.ts](../../packages/coding-agent/src/core/tools/pi/write.ts) |
| `packages/coding-agent/src/core/tools/pi/utils` | [bmp-source.ts](../../packages/coding-agent/src/core/tools/pi/utils/bmp-source.ts) · [child-process.ts](../../packages/coding-agent/src/core/tools/pi/utils/child-process.ts) · [image-budget.ts](../../packages/coding-agent/src/core/tools/pi/utils/image-budget.ts) · [image-process.ts](../../packages/coding-agent/src/core/tools/pi/utils/image-process.ts) · [image-resize-core.ts](../../packages/coding-agent/src/core/tools/pi/utils/image-resize-core.ts) · [image-resize.ts](../../packages/coding-agent/src/core/tools/pi/utils/image-resize.ts) · [image-source.ts](../../packages/coding-agent/src/core/tools/pi/utils/image-source.ts) · [mime.ts](../../packages/coding-agent/src/core/tools/pi/utils/mime.ts) · [paths.ts](../../packages/coding-agent/src/core/tools/pi/utils/paths.ts) · [read-file.ts](../../packages/coding-agent/src/core/tools/pi/utils/read-file.ts) · [shell.ts](../../packages/coding-agent/src/core/tools/pi/utils/shell.ts) · [text.ts](../../packages/coding-agent/src/core/tools/pi/utils/text.ts) |

### [联网搜索、抓取与来源图标](web.md)

| 目录 | 文件 |
| --- | --- |
| `packages/desktop/src/main` | [web-client.ts](../../packages/desktop/src/main/web-client.ts) · [web-icon-image.ts](../../packages/desktop/src/main/web-icon-image.ts) · [web-source-icons.ts](../../packages/desktop/src/main/web-source-icons.ts) · [web-tools.ts](../../packages/desktop/src/main/web-tools.ts) |
| `packages/desktop/src/renderer` | [WebSearchSettings.tsx](../../packages/desktop/src/renderer/WebSearchSettings.tsx) · [web-search-settings.css](../../packages/desktop/src/renderer/web-search-settings.css) |
| `packages/ui/src/components` | [AnswerSources.tsx](../../packages/ui/src/components/AnswerSources.tsx) · [WebToolBlock.tsx](../../packages/ui/src/components/WebToolBlock.tsx) · [answer-sources.css](../../packages/ui/src/components/answer-sources.css) · [answer-sources.ts](../../packages/ui/src/components/answer-sources.ts) · [web-tool-data.ts](../../packages/ui/src/components/web-tool-data.ts) |

## 配置、资源与测试设施

| 路径 | 负责的内容 | 说明 |
| --- | --- | --- |
| [package.json](../../package.json)、[package-lock.json](../../package-lock.json)、各包 package.json | workspace、版本、依赖、打包入口 | [构建](development.md) · [打包](packaging.md) |
| [tsconfig.json](../../tsconfig.json)、[biome.json](../../biome.json) | 类型与格式规则 | [开发](development.md) |
| [vitest.config.ts](../../vitest.config.ts)、[playwright.config.ts](../../playwright.config.ts)、[交互配置](../../playwright.interactive.config.ts) | 测试分层、启动与隔离 | [测试](testing.md) |
| [Vite](../../packages/desktop/vite.config.ts)、[PDF assets 插件](../../packages/desktop/pdf-assets-plugin.ts) | renderer、worker、本地 PDF 资源 | [构建](development.md) · [预览](previews.md) |
| [desktop assets](../../packages/desktop/src/renderer/assets)、[public](../../packages/desktop/src/renderer/public)、[icon.png](../../icon.png) | 提供商图标、字体、提示音与应用资源 | [界面](rendering.md) · [打包](packaging.md) |
| [tests](../../tests)、各包 test | fixture、假模型、DOM/服务/Electron/平台验证 | [测试](testing.md) |
| [licenses](../../licenses/third-party-notices.txt) | 随分发保留的第三方许可和来源 | [打包](packaging.md) |

## 维护约定

新增、移动或删除源文件时，同步调整本表和主要说明页。只把新文件加进表格不算完成文档：应说明可见行为、状态归属、输入输出、并发/取消/失败，以及最低合适层的回归依据。数值和协议参数在主要说明页维护，功能页通过链接引用。
