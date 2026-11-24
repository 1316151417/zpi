import type { HookInput } from "@zpi-dev/coding-agent";
import type { BuiltinPluginPorts } from "./ports.ts";

interface NotificationPorts extends Pick<BuiltinPluginPorts, "closing" | "notify"> {
  sessions: Pick<BuiltinPluginPorts["sessions"], "get" | "configuration" | "closed">;
}
export class NotificationsPlugin {
  private readonly ports: NotificationPorts;
  private readonly recent = new Map<string, number>();
  constructor(ports: NotificationPorts) {
    this.ports = ports;
  }

  title(id: string): string | undefined {
    const record = this.ports.sessions.get(id);
    return record && !record.parentSessionId && !this.ports.sessions.closed(id) ? record.title : undefined;
  }
  send(id: string, input: Extract<HookInput, { event: "Notification" }>): boolean {
    const { sessions } = this.ports;
    const record = sessions.get(id);
    if (!record || this.ports.closing() || sessions.closed(id)) return false;
    const sideChat = Boolean(record.parentSessionId);
    const parentTitle = record.parentSessionId ? this.title(record.parentSessionId) : undefined;
    if (sideChat && (record.draft || parentTitle === undefined || sessions.configuration(id).subagentProfile))
      return false;
    const category = input.notificationType === "task_failed" ? "failed" : "completed";
    const now = Date.now();
    for (const [key, timestamp] of this.recent) if (now - timestamp > 3000) this.recent.delete(key);
    const key = `${category}:${id}`;
    const previous = this.recent.get(key);
    if (previous !== undefined && now - previous < 3000) return false;
    const title = `${sideChat ? "辅助对话" : "任务"}${category === "failed" ? "出错" : "已完成"}`;
    const taskTitle = (parentTitle ?? input.message).trim();
    const delivered = this.ports.notify({
      sessionId: id,
      title,
      body: taskTitle ? `任务：${taskTitle}` : title,
    });
    if (delivered) this.recent.set(key, now);
    return delivered;
  }
  close(): void {
    this.recent.clear();
  }
}
