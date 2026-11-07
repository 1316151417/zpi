import { resolve } from "node:path";
import type { Model } from "zpi-ai";
import type { ModelRuntime } from "zpi-coding-agent";
import type { CombinedSelection } from "../../shared/bridge.ts";
import type { MemorySettings, MemorySource } from "../../shared/memory.ts";
import type { LongMemoryService, MemoryRunRequest } from "../memory/long-memory.ts";
import { runMemoryRequest } from "../memory/runner.ts";
import { readShortMemory } from "../memory/short-memory.ts";

export type MemoryMode = "off" | "short" | "long";
export interface MemoryInheritance {
  memoryInstructions?: string[];
  memoryShortInstructions?: string[];
}
interface MemoryContext extends MemoryInheritance {
  cwd: string;
  workspace?: string;
  child: boolean;
  parentId?: string;
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
  updateInheritance(id: string, value: MemoryInheritance): void;
};
export class MemoryPolicy {
  private batch?: Promise<void>;
  private models = new Map<string, { runtime: ModelRuntime; model: Model } | Error>();
  private snapshots = new Map<
    string,
    {
      instructions: string[];
      shortInstructions: string[];
      sources: MemorySource[];
      diagnostics: { path: string; message: string }[];
    }
  >();
  private used = new Map<string, MemorySource[]>();
  private selected = new Set<string>();
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
  async prepare(id: string, mode: MemoryMode, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    const context = this.port.context(id);
    if (context.child) {
      this.refreshChild(id);
      return;
    }
    const short =
      mode === "short"
        ? await readShortMemory({ homeDir: this.port.homeDir, workspace: context.workspace })
        : { instructions: [], diagnostics: [] };
    const long = mode === "long" ? await this.port.longMemory.context() : { instructions: [], sources: [] };
    signal?.throwIfAborted();
    if (mode === "long") this.selected.add(id);
    else this.selected.delete(id);
    this.used.set(id, []);
    this.snapshots.set(id, {
      instructions: [...short.instructions, ...long.instructions],
      shortInstructions: short.instructions,
      sources: long.sources,
      diagnostics: short.diagnostics,
    });
  }
  inherit(childId: string, parentId: string): MemoryInheritance {
    const snapshot = this.snapshots.get(parentId);
    if (this.selected.has(parentId)) this.selected.add(childId);
    return {
      memoryInstructions: structuredClone(snapshot?.instructions ?? []),
      memoryShortInstructions: structuredClone(snapshot?.shortInstructions ?? []),
    };
  }
  refreshChild(id: string): void {
    const context = this.port.context(id);
    if (!context.child) return;
    const parent = context.parentId ? this.snapshots.get(context.parentId) : undefined;
    if (parent && context.parentId && this.selected.has(context.parentId)) {
      this.selected.add(id);
      this.port.updateInheritance(id, {
        memoryInstructions: [...parent.instructions],
        memoryShortInstructions: [...parent.shortInstructions],
      });
    } else if (!this.selected.has(id)) {
      const short = parent?.shortInstructions ?? context.memoryShortInstructions ?? [];
      this.port.updateInheritance(id, {
        memoryInstructions: [...short],
        memoryShortInstructions: [...short],
      });
    }
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
  settled(id: string): void {
    if (!this.port.context(id).child) this.selected.delete(id);
  }
  withdraw(ids: Iterable<string>): void {
    for (const snapshot of this.snapshots.values()) {
      snapshot.instructions = [...snapshot.shortInstructions];
      snapshot.sources = [];
    }
    this.used.clear();
    this.selected.clear();
    for (const id of ids) {
      const context = this.port.context(id);
      if (!context.child) continue;
      this.port.updateInheritance(id, {
        memoryInstructions: [...(context.memoryShortInstructions ?? [])],
      });
    }
  }
  forget(id: string): void {
    this.snapshots.delete(id);
    this.used.delete(id);
    this.selected.delete(id);
  }
  close(): void {
    this.selected.clear();
  }
}
