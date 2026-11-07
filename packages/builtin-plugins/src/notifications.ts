import type { HookInput } from "zpi-coding-agent";
import type { BuiltinPluginPorts } from "./ports.ts";

interface NotificationPorts extends Pick<BuiltinPluginPorts, "closing" | "notify"> {
  sessions: Pick<BuiltinPluginPorts["sessions"], "get">;
}
export class NotificationsPlugin {
  private readonly ports: NotificationPorts;
  private readonly recent = new Map<string, number>();
  constructor(ports: NotificationPorts) {
    this.ports = ports;
  }

  title(id: string): string | undefined {
    const record = this.ports.sessions.get(id);
    return record && record.archivedAt == null && !record.parentSessionId ? record.title : undefined;
  }
  private eligible(id: string): boolean {
    return this.title(id) !== undefined && !this.ports.closing();
  }
  send(id: string, input: Extract<HookInput, { event: "Notification" }>): boolean {
    if (!this.eligible(id)) return false;
    const category = input.notificationType === "task_failed" ? "failed" : "completed";
    const now = Date.now();
    for (const [key, timestamp] of this.recent) if (now - timestamp > 3000) this.recent.delete(key);
    const key = `${category}:${id}`;
    const previous = this.recent.get(key);
    if (previous !== undefined && now - previous < 3000) return false;
    const title = category === "failed" ? "任务出错" : "任务已完成";
    const delivered = this.ports.notify({
      sessionId: id,
      title,
      body: input.message.trim() ? `任务：${input.message.trim()}` : title,
    });
    if (delivered) this.recent.set(key, now);
    return delivered;
  }
  close(): void {
    this.recent.clear();
  }
}
