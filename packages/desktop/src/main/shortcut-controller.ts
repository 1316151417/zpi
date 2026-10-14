import type { PublicSettings } from "../shared/bridge.ts";
import { normalizeShortcuts, type ShortcutSettings } from "../shared/shortcuts.ts";

export interface GlobalShortcutRegistry {
  register(accelerator: string, callback: () => void): boolean;
  unregister(accelerator: string): void;
}
/** Owns only the global window shortcut, with registration and persistence committed together. */
export class ShortcutController {
  private binding: string | null = null;
  private registered: string | null = null;
  private registrationVersion = 0;
  private activeVersion = 0;
  private capturing = false;
  private disposed = false;
  private registry: GlobalShortcutRegistry;
  private platform: string;
  private execute: () => void;
  private testMode: boolean;
  private ignoreMenuShortcuts: (ignore: boolean) => void;
  constructor(
    registry: GlobalShortcutRegistry,
    platform: string,
    execute: () => void,
    testMode = false,
    ignoreMenuShortcuts: (ignore: boolean) => void = () => {},
  ) {
    this.registry = registry;
    this.platform = platform;
    this.execute = execute;
    this.testMode = testMode;
    this.ignoreMenuShortcuts = ignoreMenuShortcuts;
  }
  get isCapturing(): boolean {
    return this.capturing;
  }
  setCapture(capturing: boolean): void {
    if (typeof capturing !== "boolean") throw new Error("invalid_input: 快捷键录制状态无效");
    if (this.disposed) return;
    try {
      if (capturing) {
        this.capturing = true;
        if (this.registered && !this.testMode) this.registry.unregister(this.registered);
        this.registered = null;
      } else {
        this.capturing = false;
        if (this.binding && !this.registered) {
          this.activeVersion = this.register(this.binding);
          this.registered = this.binding;
        }
      }
    } finally {
      // Menu accelerators must not consume a recording, even when global restoration fails.
      this.ignoreMenuShortcuts(this.capturing);
    }
  }
  private register(binding: string): number {
    const version = ++this.registrationVersion;
    if (this.testMode) return version;
    let registered = false;
    try {
      registered = this.registry.register(binding, () => {
        if (
          !this.disposed &&
          !this.capturing &&
          this.registered === binding &&
          this.activeVersion === version
        )
          this.execute();
      });
    } catch {
      // Electron may reject a platform-specific accelerator before registration.
    }
    if (!registered)
      throw new Error("configuration: 全局快捷键注册失败，可能已被其他应用或系统占用，请更换组合");
    return version;
  }
  initialize(settings: ShortcutSettings): void {
    this.update(settings, () => undefined);
  }
  update(settings: ShortcutSettings, persist: (settings: ShortcutSettings) => PublicSettings): PublicSettings;
  update(settings: ShortcutSettings, persist: (settings: ShortcutSettings) => undefined): undefined;
  update(
    settings: ShortcutSettings,
    persist: (settings: ShortcutSettings) => PublicSettings | undefined,
  ): PublicSettings | undefined {
    if (this.disposed) throw new Error("busy: 应用正在退出");
    if (this.capturing) throw new Error("busy: 请先结束快捷键录制");
    const normalized = normalizeShortcuts(settings, this.platform);
    const next = normalized.enabled ? normalized.bindings["toggle-window"] : null;
    const previous = this.registered;
    const changed = next !== previous;
    const nextVersion = changed && next ? this.register(next) : this.activeVersion;
    let result: PublicSettings | undefined;
    try {
      result = persist(normalized);
    } catch (error) {
      if (changed && next && !this.testMode) this.registry.unregister(next);
      throw error;
    }
    this.binding = next;
    this.registered = next;
    this.activeVersion = nextVersion;
    if (changed && previous && !this.testMode) this.registry.unregister(previous);
    return result;
  }
  dispose(): void {
    this.disposed = true;
    this.capturing = false;
    try {
      if (this.registered && !this.testMode) this.registry.unregister(this.registered);
    } finally {
      this.registered = null;
      this.binding = null;
      this.ignoreMenuShortcuts(false);
    }
  }
}
export interface ShortcutWindow {
  isDestroyed(): boolean;
  isVisible(): boolean;
  isFocused(): boolean;
  isMinimized(): boolean;
  hide(): void;
  restore(): void;
  show(): void;
  focus(): void;
}
/** Hiding a window never touches the session host or its running work. */
export function toggleShortcutWindow(window: ShortcutWindow): void {
  if (window.isDestroyed()) return;
  if (window.isVisible() && window.isFocused() && !window.isMinimized()) {
    window.hide();
    return;
  }
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}
