import type { PluginNotification } from "@zpi-dev/builtin-plugins/types";
import { app, BrowserWindow, Notification } from "electron";
import type { InterfacePreferences } from "../shared/bridge.ts";

// Native delivery and window activation adapted from ZCode desktopNotifications.ts.
const maxActiveNotifications = 100;

export class TaskNotifications {
  private active = new Set<Notification>();
  private disposed = false;
  private window: BrowserWindow;
  private preferences: () => InterfacePreferences;

  constructor(window: BrowserWindow, preferences: () => InterfacePreferences) {
    this.window = window;
    this.preferences = preferences;
  }

  show({ sessionId, title, body }: PluginNotification): boolean {
    if (
      this.disposed ||
      this.window.isDestroyed() ||
      !this.preferences().notificationEnabled ||
      !Notification.isSupported() ||
      BrowserWindow.getAllWindows().some((window) => !window.isDestroyed() && window.isFocused())
    )
      return false;

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
        window.webContents.send("zpi:task-notification-click", sessionId);
      });
      notification.once("close", () => this.active.delete(current));
      notification.once("failed", () => this.active.delete(current));
      notification.show();
      this.window.webContents.send("zpi:task-notification-sound");
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
  }
}
