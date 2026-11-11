import { createContext, useContext, useEffect, useRef } from "react";

export const ComposerCommandsContext = createContext<Map<string, () => void> | null>(null);

/** Register a toolbar action in its owning composer, including actions rendered in portals. */
export function useComposerCommand(command: string, handler: (() => void) | undefined): void {
  const commands = useContext(ComposerCommandsContext);
  const callback = useRef(handler);
  callback.current = handler;
  useEffect(() => {
    if (!commands) return;
    const invoke = () => callback.current?.();
    commands.set(command, invoke);
    return () => {
      if (commands.get(command) === invoke) commands.delete(command);
    };
  }, [command, commands]);
}
