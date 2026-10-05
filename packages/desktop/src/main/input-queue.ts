import { randomUUID } from "node:crypto";
import type { InputQueue, QueuedInput, RunStatus } from "zpi-ui";
import type { RunInput } from "../shared/bridge.ts";

interface QueueRuntime {
  check(id: string): void;
  running(id: string): boolean;
  prepare(input: RunInput): Promise<Omit<QueuedInput, "id" | "state">>;
  retain(id: string, item: QueuedInput, retained: boolean): Promise<void>;
  discard(id: string, item: QueuedInput): Promise<void>;
  withdraw(id: string, item: QueuedInput): Promise<void>;
  start(input: RunInput, item?: QueuedInput): Promise<{ runId: string }>;
  stop(id: string): Promise<void>;
  save(id: string, queue: InputQueue): void;
  publish(id: string, queue: InputQueue): void;
}
/** Desktop input delivery only. Agent prompts, tools and history remain owned by SessionHost. */
export class SessionInputQueue {
  private states = new Map<string, InputQueue>();
  private operations = new Map<string, Promise<unknown>>();
  private preempting = new Set<string>();
  private closing = false;
  private runtime: QueueRuntime;
  constructor(runtime: QueueRuntime) {
    this.runtime = runtime;
  }
  get(id: string): InputQueue {
    return this.states.get(id) ?? { items: [], autoDrain: true };
  }
  restore(id: string, state: InputQueue, acceptedId?: string): void {
    const items = state.items
      .filter((item) => item.id !== acceptedId)
      .map((item) => ({ ...item, state: "queued" as const }));
    this.states.set(id, {
      ...state,
      items,
      autoDrain: !items.length,
      ...(items.length ? { pauseReason: state.pauseReason ?? "restart" } : {}),
    });
  }
  private commit(id: string, queue: InputQueue): void {
    this.runtime.save(id, queue);
    this.states.set(id, queue);
    this.runtime.publish(id, queue);
  }
  private serial<T>(id: string, work: () => Promise<T>): Promise<T> {
    const result = (this.operations.get(id) ?? Promise.resolve())
      .catch(() => {})
      .then(() => {
        if (this.closing) throw new Error("busy: 应用正在关闭");
        this.runtime.check(id);
        return work();
      });
    this.operations.set(id, result);
    void result
      .finally(() => {
        if (this.operations.get(id) === result) this.operations.delete(id);
      })
      .catch(() => {});
    return result;
  }
  async submit(input: RunInput, disposition?: "keep" | "clear") {
    return this.serial(input.sessionId, async () => {
      if (this.closing) throw new Error("busy: 应用正在关闭");
      const id = input.sessionId,
        queue = this.get(id);
      if (!this.runtime.running(id) && (!queue.items.length || (!queue.autoDrain && disposition))) {
        // Validate before clearing a held queue, so a failed send cannot erase accepted inputs.
        if (queue.items.length) await this.runtime.prepare(input);
        const result = await this.runtime.start(input);
        if (queue.items.length) {
          this.commit(id, { items: disposition === "clear" ? [] : queue.items, autoDrain: true });
          if (disposition === "clear")
            for (const item of queue.items) await this.runtime.discard(id, item).catch(() => {});
        }
        return result;
      }
      if (!this.runtime.running(id) && !queue.autoDrain && !disposition)
        return { confirmationRequired: true as const };
      const prepared = await this.runtime.prepare(input);
      if (this.closing) throw new Error("busy: 应用正在关闭");
      if (
        queue.items.some((item) =>
          item.attachments.some((image) => prepared.attachments.some((incoming) => incoming.id === image.id)),
        )
      )
        throw new Error("invalid_input: 图片已属于待发送消息");
      const item: QueuedInput = { ...prepared, id: randomUUID(), state: "queued" };
      await this.runtime.retain(id, item, true);
      try {
        this.commit(id, { ...queue, items: [...queue.items, item] });
      } catch (error) {
        await this.runtime.retain(id, item, false);
        throw error;
      }
      if (!this.runtime.running(id) && queue.autoDrain) void this.resume(id).catch(() => {});
      return { queueItemId: item.id };
    });
  }
  private item(id: string, itemId: string): QueuedInput {
    const item = this.get(id).items.find((item) => item.id === itemId);
    if (!item) throw new Error("not_found: 待发送消息不存在");
    if (item.state !== "queued") throw new Error("busy: 待发送消息正在提交");
    return item;
  }
  remove(id: string, itemId: string, edit = false): Promise<QueuedInput> {
    return this.serial(id, async () => {
      const item = this.item(id, itemId),
        queue = this.get(id);
      if (edit) await this.runtime.withdraw(id, item);
      this.commit(id, { ...queue, items: queue.items.filter((item) => item.id !== itemId) });
      if (edit) await this.runtime.retain(id, item, false);
      else await this.runtime.discard(id, item).catch(() => {});
      return item;
    });
  }
  move(id: string, itemId: string, beforeId: string | null): Promise<void> {
    return this.serial(id, async () => {
      const item = this.item(id, itemId),
        queue = this.get(id);
      if (beforeId === itemId) return;
      if (beforeId !== null) this.item(id, beforeId);
      const items = queue.items.filter((item) => item.id !== itemId);
      const index = beforeId === null ? items.length : items.findIndex((item) => item.id === beforeId);
      items.splice(index, 0, item);
      this.commit(id, { ...queue, items });
    });
  }
  private async dispatch(id: string, item: QueuedInput): Promise<void> {
    const queue = this.get(id);
    let accepted = false;
    this.commit(id, {
      items: queue.items.map((value) => (value.id === item.id ? { ...value, state: "dispatching" } : value)),
      autoDrain: true,
    });
    try {
      if (this.closing) throw new Error("busy: 应用正在关闭");
      await this.runtime.start(
        {
          sessionId: id,
          text: item.text,
          fileReferences: item.fileReferences,
          attachments: item.attachments.map((image) => image.id),
        },
        item,
      );
      accepted = true;
      this.commit(id, { items: this.get(id).items.filter((value) => value.id !== item.id), autoDrain: true });
    } catch (error) {
      const paused: InputQueue = {
        // A run already accepted by the host must never be delivered again after a queue-save error.
        items: this.get(id)
          .items.filter((value) => !accepted || value.id !== item.id)
          .map((value) => (value.id === item.id ? { ...value, state: "queued" } : value)),
        autoDrain: false,
        pauseReason: "error",
        error: error instanceof Error ? error.message : String(error),
      };
      try {
        this.commit(id, paused);
      } catch {
        this.states.set(id, paused);
        this.runtime.publish(id, paused);
      }
      throw error;
    }
  }
  sendNow(id: string, itemId: string): Promise<void> {
    return this.serial(id, async () => {
      const item = this.item(id, itemId);
      this.preempting.add(id);
      try {
        await this.runtime.stop(id);
        this.preempting.delete(id);
        await this.dispatch(id, item);
      } finally {
        this.preempting.delete(id);
      }
    });
  }
  resume(id: string): Promise<void> {
    return this.serial(id, async () => {
      if (this.closing) return;
      const queue = this.get(id);
      this.commit(id, { items: queue.items, autoDrain: true });
      if (!this.runtime.running(id) && queue.items[0]) await this.dispatch(id, queue.items[0]);
    });
  }
  settled(id: string, status: Exclude<RunStatus, "running">): void {
    if (this.preempting.has(id) || this.closing) return;
    void this.serial(id, async () => {
      if (this.closing) return;
      const queue = this.get(id);
      if (!queue.items.length) return;
      if (status !== "completed")
        this.commit(id, {
          ...queue,
          autoDrain: false,
          pauseReason: status === "error" ? "error" : "stopped",
        });
      else if (queue.autoDrain && !this.runtime.running(id)) await this.dispatch(id, queue.items[0]);
    }).catch(() => {});
  }
  async delete(id: string): Promise<void> {
    await this.operations.get(id)?.catch(() => {});
    this.states.delete(id);
  }
  archive(id: string, persist: () => void): Promise<void> {
    return this.serial(id, async () => {
      if (this.runtime.running(id)) throw new Error("busy: 请先停止运行");
      const items = this.get(id).items;
      this.commit(id, { items: [], autoDrain: false });
      persist();
      for (const item of items) await this.runtime.discard(id, item).catch(() => {});
    });
  }
  async close(): Promise<void> {
    this.closing = true;
    await Promise.allSettled(this.operations.values());
    for (const [id, queue] of this.states)
      if (queue.items.length)
        this.commit(id, { ...queue, autoDrain: false, pauseReason: queue.pauseReason ?? "restart" });
  }
}
