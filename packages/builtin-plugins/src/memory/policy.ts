import { resolve } from "node:path";
import type { Model } from "@zpi-dev/ai";
import type { ModelRuntime } from "@zpi-dev/coding-agent";
import type { CombinedSelection } from "../types.ts";
import type { LongMemoryService, MemoryRunRequest } from "./long-memory.ts";
import { runMemoryRequest } from "./runner.ts";
import { readShortMemory } from "./short-memory.ts";
import type { MemoryInheritance, MemorySettings, MemorySource, SessionMemorySnapshot } from "./types.ts";

export type MemoryMode = "off" | "short" | "long";
interface MemoryContext extends MemoryInheritance {
  cwd: string;
  workspace?: string;
  child: boolean;
}
/** Owns selection and usage policy; durable memory generation remains in LongMemoryService. */
type MemoryPort = {
  settings(): MemorySettings;
  selection(id: string | null): CombinedSelection | null;
  model(selection: CombinedSelection): { runtime: ModelRuntime; model: Model };
  closing(): boolean;
  error(error: unknown): void;
  homeDir: string;
  longMemory: LongMemoryService;
  context(id: string): MemoryContext;
};
export class MemoryPolicy {
  private batch?: Promise<void>;
  private models = new Map<string, { runtime: ModelRuntime; model: Model } | Error>();
  private snapshots = new Map<string, SessionMemorySnapshot>();
  private used = new Map<string, MemorySource[]>();
  private readonly port: MemoryPort;
  constructor(port: MemoryPort) {
    this.port = port;
  }
  private modelKey(selection: CombinedSelection): string {
    return JSON.stringify(selection);
  }
  async run(request: MemoryRunRequest) {
    request.signal.throwIfAborted();
    const selected = this.models.get(this.modelKey(request.model));
    if (selected instanceof Error) throw selected;
    if (!selected) throw new Error("configuration: 记忆批次模型快照不可用");
    const { runtime, model } = selected;
    return runMemoryRequest(request, runtime, model);
  }
  schedule(id: string | null): void {
    const settings = this.port.settings();
    this.port.longMemory.configure(settings);
    if (this.port.closing() || this.batch || !settings.long || !settings.generate) return;
    const trigger = this.port.selection(id) ?? {
      provider: "",
      modelId: "",
      reasoning: "none" as const,
    };
    const base = settings.modelMode === "manual" ? settings.selection : trigger;
    this.models.clear();
    for (const selection of [settings.extractSelection ?? base, settings.consolidateSelection ?? base]) {
      if (!selection) continue;
      const key = this.modelKey(selection);
      try {
        const { runtime, model } = this.port.model(selection);
        this.models.set(key, { runtime, model });
      } catch (error) {
        this.models.set(key, error instanceof Error ? error : new Error(String(error)));
      }
    }
    this.batch = this.port.longMemory
      .check(structuredClone(trigger), structuredClone(settings))
      .catch((error) => this.port.error(error))
      .finally(() => {
        this.batch = undefined;
        this.models.clear();
      });
  }
  async configure(settings: MemorySettings): Promise<void> {
    this.port.longMemory.configure(settings);
    if (!settings.long || !settings.generate) {
      await this.port.longMemory.stop();
      await this.batch;
    }
  }
  async wait(): Promise<void> {
    await this.batch;
  }
  /** Called only when the host captures the first input's injected resources. */
  async capture(id: string, mode: MemoryMode): Promise<void> {
    if (this.snapshots.has(id)) return;
    const context = this.port.context(id);
    if (context.child) return;
    const short =
      mode === "short"
        ? await readShortMemory({ homeDir: this.port.homeDir, workspace: context.workspace })
        : { instructions: [], diagnostics: [] };
    const long = mode === "long" ? await this.port.longMemory.context() : { instructions: [], sources: [] };
    this.used.set(id, []);
    this.snapshots.set(id, {
      instructions: [...short.instructions, ...long.instructions],
      shortInstructions: short.instructions,
      sources: long.sources,
      diagnostics: short.diagnostics,
    });
  }
  snapshot(id: string): SessionMemorySnapshot {
    return structuredClone(
      this.snapshots.get(id) ?? {
        instructions: [],
        shortInstructions: [],
        sources: [],
        diagnostics: [],
      },
    );
  }
  restore(id: string, snapshot: SessionMemorySnapshot): void {
    this.snapshots.set(id, structuredClone(snapshot));
  }
  /** Per-turn bookkeeping only: never discovers or reads memory files. */
  beginTurn(id: string): void {
    this.used.set(id, []);
  }
  inherit(parentId: string): MemoryInheritance {
    const snapshot = this.snapshots.get(parentId);
    return {
      memoryInstructions: structuredClone(snapshot?.instructions ?? []),
      memoryShortInstructions: structuredClone(snapshot?.shortInstructions ?? []),
    };
  }
  instructions(id: string): string[] {
    const context = this.port.context(id);
    return context.child
      ? [
          ...(context.memoryInstructions ?? []),
          "Inherited memory is historical reference only. Do not maintain shared short memory files or long memory notes from a delegated task.",
        ]
      : [...(this.snapshots.get(id)?.instructions ?? [])];
  }
  recordRead(id: string, path: string): void {
    const context = this.port.context(id);
    if (context.child) return;
    const source = this.snapshots
      .get(id)
      ?.sources.find((item) => item.summaryPath === resolve(context.cwd, path));
    if (!source) return;
    this.port.longMemory.recordUsage([source.sessionId]);
    const used = this.used.get(id) ?? [];
    if (!used.some((item) => item.sessionId === source.sessionId)) this.used.set(id, [...used, source]);
  }
  diagnostics(id: string) {
    return structuredClone(this.snapshots.get(id)?.diagnostics ?? []);
  }
  usedSources(id: string) {
    return structuredClone(this.used.get(id) ?? []);
  }
  forget(id: string): void {
    this.snapshots.delete(id);
    this.used.delete(id);
  }
}
