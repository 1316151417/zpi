import type { DesktopEventEnvelope } from "ZPI-ui";
import { app, BrowserWindow, Notification } from "electron";
import type { InterfacePreferences } from "../shared/bridge.ts";

// Adapted from ZCode desktopNotifications.ts; ZPI supplies live run events directly.
const dedupeWindowMs = 3000;
const maxActiveNotifications = 100;

export class TaskNotifications {
  private recent = new Map<string, number>();
  private active = new Set<Notification>();
  private disposed = false;
  private window: BrowserWindow;
  private preferences: () => InterfacePreferences;

  constructor(window: BrowserWindow, preferences: () => InterfacePreferences) {
    this.window = window;
    this.preferences = preferences;
  }

  handle(envelope: DesktopEventEnvelope, taskTitle: string): boolean {
    const { event, sessionId } = envelope;
    if (
      event.type !== "settled" ||
      this.disposed ||
      this.window.isDestroyed() ||
      !this.preferences().notificationEnabled ||
      !Notification.isSupported() ||
      BrowserWindow.getAllWindows().some((window) => !window.isDestroyed() && window.isFocused())
    )
      return false;

    // ZCode treats completedInterrupted as completed, including a manually stopped turn.
    const status = event.status === "error" ? "failed" : "completed";
    const title = status === "failed" ? "任务出错" : "任务已完成";
    const body = taskTitle.trim() ? `任务：${taskTitle.trim()}` : title;
    const now = Date.now();
    for (const [key, timestamp] of this.recent) if (now - timestamp > dedupeWindowMs) this.recent.delete(key);
    const key = `${status}:${sessionId}`;
    const previous = this.recent.get(key);
    if (previous !== undefined && now - previous < dedupeWindowMs) return false;
    this.recent.set(key, now);

    let notification: Notification | undefined;
    try {
      notification = new Notification({ title, body, silent: true });
      const current = notification;
      // Keep the JS object alive so clicking a system notification retains its listener.
      this.active.add(notification);
      if (this.active.size > maxActiveNotifications) {
        const oldest = this.active.values().next().value;
        if (oldest) this.active.delete(oldest);
      }
      notification.once("click", () => {
        this.active.delete(current);
        const window = this.window;
        if (this.disposed || window.isDestroyed()) return;
        if (window.isMinimized()) window.restore();
        if (!window.isVisible()) window.show();
        if (process.platform === "darwin") {
          app.dock?.show();
          app.show();
          app.focus({ steal: true });
        }
        window.focus();
        window.webContents.send("ZPI:task-notification-click", sessionId);
      });
      notification.once("close", () => this.active.delete(current));
      notification.once("failed", () => this.active.delete(current));
      notification.show();
      this.window.webContents.send("ZPI:task-notification-sound");
      return true;
    } catch {
      if (notification) this.active.delete(notification);
      // Desktop notification failures must not affect run settlement or queue delivery.
      return false;
    }
  }

  dispose(): void {
    this.disposed = true;
    for (const notification of this.active) notification.close();
    this.active.clear();
    this.recent.clear();
  }
}
