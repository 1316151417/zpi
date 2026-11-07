import type { ImageContent, Model } from "zpi-ai";
import type { ModelRuntime } from "zpi-coding-agent";
import { generateSessionTitle } from "../session-title.ts";

export interface TitleRequest {
  text: string;
  images: ImageContent[];
  model: Model;
  runtime(): Promise<ModelRuntime>;
}
interface TitleState {
  titleState?: string;
}
type TitlePort = {
  state(id: string): TitleState | undefined;
  save(id: string, patch: TitleState & { title?: string }): void;
  changed(id: string, title: string, generated: boolean): void;
  alive(id: string): boolean;
  error(error: unknown, id: string, model: Model): void;
};
export class TitlePolicy {
  readonly jobs = new Map<string, { controller: AbortController; done: Promise<void> }>();
  private readonly port: TitlePort;
  constructor(port: TitlePort) {
    this.port = port;
  }
  fallback(id: string, text: string): void {
    if (this.port.state(id)?.titleState !== "new") return;
    const visible = text.trim().replace(/\s+/g, " ");
    const characters = Array.from(
      new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(visible),
      (part) => part.segment,
    );
    const title = (characters.length > 20 ? `${characters.slice(0, 20).join("")}…` : visible) || "图片消息";
    this.port.save(id, { title });
    this.port.changed(id, title, false);
  }
  start(id: string, request: TitleRequest): void {
    try {
      if (this.port.state(id)?.titleState !== "new") return;
      this.port.save(id, { titleState: "pending" });
    } catch (error) {
      this.port.error(error, id, request.model);
      return;
    }
    const controller = new AbortController();
    const done = Promise.resolve()
      .then(async () => {
        try {
          controller.signal.throwIfAborted();
          const runtime = await request.runtime();
          controller.signal.throwIfAborted();
          const title = await generateSessionTitle(
            runtime,
            structuredClone(request.model),
            request.text,
            request.images,
            controller.signal,
          );
          if (!this.port.alive(id) || this.port.state(id)?.titleState !== "pending") return;
          this.port.save(id, { title, titleState: "generated" });
          this.port.changed(id, title, true);
        } catch (error) {
          if (!controller.signal.aborted) this.port.error(error, id, request.model);
          if (this.port.state(id)?.titleState === "pending") this.port.save(id, { titleState: "failed" });
        } finally {
          this.jobs.delete(id);
        }
      })
      .catch((error) => this.port.error(error, id, request.model));
    this.jobs.set(id, { controller, done });
  }
  cancel(id: string): void {
    this.jobs.get(id)?.controller.abort();
  }
  async wait(id: string): Promise<void> {
    await this.jobs.get(id)?.done;
  }
  async close(): Promise<void> {
    for (const job of this.jobs.values()) job.controller.abort();
    await Promise.allSettled([...this.jobs.values()].map((job) => job.done));
  }
}
