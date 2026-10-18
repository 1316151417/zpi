import { createRequire as createNativeRequire } from "node:module";
import { join } from "node:path";

export function macQuickChatFocus(
  directory: string,
  fallback: () => void,
  onError: (error: unknown) => void,
  load: (path: string) => unknown = createNativeRequire(import.meta.url),
): () => (() => void) | undefined {
  let binding: { activate(): unknown } | null | undefined;
  return () => {
    if (binding !== null) {
      try {
        binding ??= load(
          join(directory, "quick-chat-focus.node").replace(/\.asar([/\\])/, ".asar.unpacked$1"),
        ) as typeof binding;
        if (!binding || typeof binding.activate !== "function")
          throw new Error("Invalid native focus module");
        const restore = binding.activate();
        if (restore !== undefined && typeof restore !== "function")
          throw new Error("Invalid native focus owner");
        return restore as (() => void) | undefined;
      } catch (error) {
        binding = null;
        onError(error);
      }
    }
    fallback();
  };
}
