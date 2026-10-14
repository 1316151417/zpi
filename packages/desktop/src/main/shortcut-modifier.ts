import type { Input, WebContents } from "electron";

/** One native owner for host and guest hints; it never consumes or dispatches a shortcut. */
export class ShortcutModifier {
  private source?: WebContents;
  private held = false;
  private pressed = new Set<string>();
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
    this.pressed.clear();
    this.update(false);
  };
  resetFor(content: WebContents): void {
    if (this.source === content) this.reset();
  }
  observe(content: WebContents, isHost = false): void {
    // Reloading the host also replaces the IPC consumer, even when a guest owns input.
    const reset = () => (isHost ? this.reset() : this.resetFor(content));
    const input = (_: unknown, input: Input) => {
      if (input.type !== "keyDown" && input.type !== "keyUp") return;
      if (!this.enabled()) return this.reset();
      this.source = content;
      const key = this.platform === "darwin" ? "Meta" : "Control";
      const primary = input.key === key || input.code === `${key}Left` || input.code === `${key}Right`;
      let held = this.platform === "darwin" ? input.meta : input.control;
      if (primary) {
        const side = input.code || key;
        if (input.type === "keyDown") this.pressed.add(side);
        else this.pressed.delete(side);
        // Modifier-only transitions are authoritative, even with stale modifier flags.
        held = this.pressed.size > 0;
      } else if (!held) this.pressed.clear();
      this.update(held);
    };
    const dispose = () => {
      content.removeListener("before-input-event", input);
      content.removeListener("did-start-loading", reset);
      content.removeListener("render-process-gone", reset);
      content.removeListener("destroyed", dispose);
      this.observers.delete(dispose);
      reset();
    };
    content.on("before-input-event", input);
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
