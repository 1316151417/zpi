import { createRequire as createNativeRequire } from "node:module";
import { join } from "node:path";

export function macQuickChatFocus(directory: string): () => (() => void) | undefined {
  const binding = createNativeRequire(import.meta.url)(
    join(directory, "quick-chat-focus.node").replace(/\.asar([/\\])/, ".asar.unpacked$1"),
  ) as { activate(): (() => void) | undefined };
  return () => binding.activate();
}
