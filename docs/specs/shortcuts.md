# 快捷键事件路由与弹层边界

## 停止回复

- Shortcut settings remain the only binding owner. The current stop callback continues to choose the main or focused auxiliary conversation.
- Bare Escape runs after local dismiss/cancel handlers, so dismissing a menu, dialog, suggestion or edit does not also stop a reply.
- A configured non-Escape stop shortcut is consumed in the document capture phase, before editors or terminals handle the same combination. It must not insert text or fall through to another action.
- Held non-Escape shortcuts are consumed without repeated stop dispatch. Composition events, key code 229, disabled/unbound shortcuts, already-handled input and dismissible overlays do not dispatch stop.
- Tests exercise the actual stop hook and message-editor handler without launching Electron, including a valid Shift+Command/Ctrl+Enter binding that otherwise inserts a newline.

## 可见弹层

- Workspace, composer and stop shortcuts share the same visibility test for blocking overlays. Existing dialog/menu/listbox/settings scopes remain unchanged.
- Only rendered, visible blockers count. A pending assistant question in a hidden or inert pane/tab must not disable shortcuts in the active conversation or workspace.
- Hidden/inert/aria-hidden ancestors, absent layout boxes and CSS visibility:hidden/collapse exclude a blocker. Visible dialogs, menus, suggestions and settings continue to block commands, including during their exit animation.
- Node regressions cover hidden and visible blockers, mixed candidate order and the real workspace/composer routing functions. Hidden Electron regression exercises an inactive auxiliary question alongside the active main composer.
