import type { Input, WebContents } from "electron";

/** One native owner for host and guest hints; it never consumes or dispatches a shortcut. */
export class ShortcutModifier {
  private source?: WebContents;
  private held = false;
  private observers = new Set<() => void>();
  private platform: string;
  private enabled: () => boolean;
  private send: (held: boolean) => void;
  constructor(platform: string, enabled: () => boolean, send: (held: boolean) => void) {
    this.platform = platform;
    this.enabled = enabled;
    this.send = send;
  }
  private update(held: boolean): void {
    if (this.held === held) return;
    this.held = held;
    this.send(held);
  }
  reset = () => {
    this.source = undefined;
    this.update(false);
  };
  resetFor(content: WebContents): void {
    if (this.source === content) this.reset();
  }
  observe(content: WebContents, isHost = false): void {
    // Reloading the host also replaces the IPC consumer, even when a guest owns input.
    const reset = () => (isHost ? this.reset() : this.resetFor(content));
    const input = (
      _: unknown,
      input: Pick<Input, "type"> & Partial<Pick<Input, "meta" | "control" | "modifiers">>,
    ) => {
      if (input.type !== "rawKeyDown" && input.type !== "keyDown" && input.type !== "keyUp") return;
      if (!this.enabled()) return this.reset();
      this.source = content;
      const flag = this.platform === "darwin" ? "meta" : "control";
      const held =
        (this.platform === "darwin" ? input.meta : input.control) ?? input.modifiers?.includes(flag) ?? false;
      this.update(held);
    };
    const dispose = () => {
      content.removeListener("before-input-event", input);
      content.removeListener("input-event", input);
      content.removeListener("did-start-loading", reset);
      content.removeListener("render-process-gone", reset);
      content.removeListener("destroyed", dispose);
      this.observers.delete(dispose);
      reset();
    };
    content.on("before-input-event", input);
    // Chromium can bypass the pre-handler (e.g. input injected through CDP).
    // input-event observes that path; keep before-input-event for consumed shortcuts.
    // Both paths may deliver the same transition, so updates must remain idempotent.
    content.on("input-event", input);
    content.on("did-start-loading", reset);
    content.on("render-process-gone", reset);
    content.on("destroyed", dispose);
    this.observers.add(dispose);
  }
  dispose(): void {
    for (const dispose of this.observers) dispose();
    this.reset();
  }
}
