import type { PublicSettings } from "../shared/bridge.ts";
import {
  type GlobalShortcutCommand,
  normalizeShortcuts,
  type ShortcutCommand,
  type ShortcutKeyEvent,
  type ShortcutSettings,
  shortcutCommands,
} from "../shared/shortcuts.ts";
import { workspaceShortcutForEvent } from "../shared/workspace-shortcuts.ts";

export interface GlobalShortcutRegistry {
  register(accelerator: string, callback: () => void): boolean;
  unregister(accelerator: string): void;
}
/** Owns the global shortcuts, with registration and persistence committed together. */
export class ShortcutController {
  private bindings = new Map<string, GlobalShortcutCommand>();
  private registered = new Map<string, number>();
  private registrationVersion = 0;
  private capturing = false;
  private disposed = false;
  private registry: GlobalShortcutRegistry;
  private platform: string;
  private execute: (command: GlobalShortcutCommand) => void;
  private testMode: boolean;
  private ignoreMenuShortcuts: (ignore: boolean) => void;
  private diagnose?: (
    stage: "shortcut-register" | "shortcut-received" | "shortcut-ignored" | "shortcut-unregister",
    binding: string,
    version: number,
    registered: boolean,
  ) => void;
  constructor(
    registry: GlobalShortcutRegistry,
    platform: string,
    execute: (command: GlobalShortcutCommand) => void,
    testMode = false,
    ignoreMenuShortcuts: (ignore: boolean) => void = () => {},
    diagnose?: ShortcutController["diagnose"],
  ) {
    this.registry = registry;
    this.platform = platform;
    this.execute = execute;
    this.testMode = testMode;
    this.ignoreMenuShortcuts = ignoreMenuShortcuts;
    this.diagnose = diagnose;
  }
  get isCapturing(): boolean {
    return this.capturing;
  }
  setCapture(capturing: boolean): void {
    if (typeof capturing !== "boolean") throw new Error("invalid_input: 快捷键录制状态无效");
    if (this.disposed) return;
    try {
      this.capturing = capturing;
      if (capturing) this.unregisterAll();
      else this.restoreAvailable();
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
        const command = this.bindings.get(binding);
        const current = Boolean(
          command && !this.disposed && !this.capturing && this.registered.get(binding) === version,
        );
        this.diagnose?.(current ? "shortcut-received" : "shortcut-ignored", binding, version, current);
        if (command && current) this.execute(command);
      });
    } catch {
      // Electron may reject a platform-specific accelerator before registration.
    }
    this.diagnose?.("shortcut-register", binding, version, registered);
    if (!registered)
      throw new Error("configuration: 全局快捷键注册失败，可能已被其他应用或系统占用，请更换组合");
    return version;
  }
  private unregister(bindings: Iterable<string>): void {
    if (this.testMode) return;
    let failure: unknown;
    for (const binding of bindings) {
      try {
        this.registry.unregister(binding);
        this.diagnose?.("shortcut-unregister", binding, this.registrationVersion, false);
      } catch (error) {
        failure ??= error;
      }
    }
    if (failure) throw failure;
  }
  private unregisterAll(): void {
    const bindings = [...this.registered.keys()];
    this.registered.clear();
    this.unregister(bindings);
  }
  private registerMissing(bindings: ReadonlyMap<string, GlobalShortcutCommand>): Map<string, number> {
    const additions = new Map<string, number>();
    try {
      for (const binding of bindings.keys()) {
        if (!this.registered.has(binding)) additions.set(binding, this.register(binding));
      }
    } catch (error) {
      this.unregister(additions.keys());
      throw error;
    }
    return additions;
  }
  private restoreAvailable(): void {
    let failure: unknown;
    // A newly occupied shortcut must not disable another saved global action on startup or capture end.
    for (const binding of this.bindings.keys()) {
      if (this.registered.has(binding)) continue;
      try {
        this.registered.set(binding, this.register(binding));
      } catch (error) {
        failure ??= error;
      }
    }
    if (failure) throw failure;
  }
  private globalBindings(settings: ShortcutSettings): Map<string, GlobalShortcutCommand> {
    const bindings = new Map<string, GlobalShortcutCommand>();
    if (settings.enabled) {
      for (const { id, scope } of shortcutCommands) {
        const binding = settings.bindings[id];
        if (scope === "global" && binding !== null) bindings.set(binding, id);
      }
    }
    return bindings;
  }
  private removeUnused(): void {
    const removed = [...this.registered.keys()].filter((binding) => !this.bindings.has(binding));
    for (const binding of removed) this.registered.delete(binding);
    this.unregister(removed);
  }
  initialize(settings: ShortcutSettings): void {
    if (this.disposed) throw new Error("busy: 应用正在退出");
    if (this.capturing) throw new Error("busy: 请先结束快捷键录制");
    this.bindings = this.globalBindings(normalizeShortcuts(settings, this.platform));
    this.removeUnused();
    this.restoreAvailable();
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
    const next = this.globalBindings(normalized);
    // Reuse accelerators across commands, so swapping bindings needs no unsafe unregister/register gap.
    const additions = this.registerMissing(next);
    let result: PublicSettings | undefined;
    try {
      result = persist(normalized);
    } catch (error) {
      this.unregister(additions.keys());
      throw error;
    }
    this.bindings = next;
    for (const [binding, version] of additions) this.registered.set(binding, version);
    this.removeUnused();
    return result;
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.capturing = false;
    this.bindings.clear();
    try {
      this.unregisterAll();
    } finally {
      this.ignoreMenuShortcuts(false);
    }
  }
}
/** A destroyed BrowserWindow can throw even when reading its webContents property. */
export function setWindowMenuShortcutsIgnored(
  window: {
    isDestroyed(): boolean;
    readonly webContents: { isDestroyed(): boolean; setIgnoreMenuShortcuts(ignore: boolean): void };
  },
  ignore: boolean,
): void {
  if (window.isDestroyed()) return;
  const contents = window.webContents;
  if (!contents.isDestroyed()) contents.setIgnoreMenuShortcuts(ignore);
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
export function toggleShortcutWindow(window: ShortcutWindow): boolean {
  if (window.isDestroyed()) return false;
  if (window.isVisible() && window.isFocused() && !window.isMinimized()) {
    window.hide();
    return false;
  }
  if (window.isMinimized()) window.restore();
  if (window.isDestroyed()) return false;
  window.show();
  if (window.isDestroyed()) return false;
  window.focus();
  return !window.isDestroyed() && window.isVisible() && window.isFocused() && !window.isMinimized();
}

/** Native browser guests use the same application command matcher as renderer capture. */
export function forwardBrowserShortcut(
  event: ShortcutKeyEvent,
  platform: string,
  settings: ShortcutSettings,
  send: (command: ShortcutCommand) => void,
  focusHost: () => void,
): boolean {
  const command = workspaceShortcutForEvent(event, platform, settings);
  if (!command) return false;
  if (!event.repeat) {
    if (command === "focus-composer") focusHost();
    send(command);
  }
  return true;
}
