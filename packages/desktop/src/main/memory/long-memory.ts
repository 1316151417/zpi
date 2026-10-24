import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readdir, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { CombinedSelection } from "../../shared/bridge.ts";
import type { LongMemoryStatus, MemorySettings, MemorySource } from "../../shared/memory.ts";
import { syncDirectory } from "../storage-generation.ts";
import { consolidationPrompt, extractionPrompt, longMemoryInstructions } from "./prompts.ts";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const MAX_SELECTED = 256;
const MAX_UNUSED_DAYS = 30;
const MAX_ATTEMPTS = 3;
const PIPELINE_VERSION = "zpi-memory-1";
const MAX_EVIDENCE_CHARACTERS = 120_000;
const MAX_SELECTED_CHARACTERS = 300_000;

export interface LongMemorySource {
  id: string;
  cwd: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  boundary: string;
  active?: boolean;
  eligible?: boolean;
  evidencePath?: string;
  /** After clear, return only evidence newer than this source boundary. */
  read(afterBoundary?: string): Promise<string>;
}

export interface MemoryRunRequest {
  stage: "extract" | "consolidate";
  prompt: string;
  model: CombinedSelection;
  signal: AbortSignal;
}

export interface MemoryRunResult {
  text: string;
  usage?: { tokens: number; cost: number | null };
}

interface MemoryRecord {
  id: string;
  title: string;
  cwd: string;
  boundary: string;
  updatedAt: number;
  generatedAt: number;
  evidencePath?: string;
  rawMemory: string;
  rolloutSummary: string;
  usageCount: number;
  lastUsage?: number;
}

interface MemoryJob {
  boundary: string;
  version: string;
  attempts: number;
  retryAt: number;
  completed: boolean;
  lastError?: string;
}

/** JSON state is owned and persisted by the desktop's existing StateStore. */
export interface LongMemoryState {
  version: 1;
  records: Record<string, MemoryRecord>;
  jobs: Record<string, MemoryJob>;
  tombstones: Record<string, string>;
  activeGeneration?: string;
  activeFingerprint?: string;
  activeSources: { id: string; boundary: string }[];
  invalidated: boolean;
  lastSuccess?: number;
  consolidationRetryAt?: number;
  lastRun?: number;
  outcome?: LongMemoryStatus["status"];
  message?: string;
  tokens: number;
  cost: number | null;
}

export interface LongMemoryOptions {
  directory: string;
  getState(): LongMemoryState | undefined;
  setState(state: LongMemoryState): void;
  sources(): Promise<LongMemorySource[]>;
  run(request: MemoryRunRequest): Promise<MemoryRunResult>;
  now?(): number;
}

function initialState(): LongMemoryState {
  return {
    version: 1,
    records: {},
    jobs: {},
    tombstones: {},
    activeSources: [],
    invalidated: false,
    tokens: 0,
    cost: 0,
  };
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function differentSourceGeneration(previous: string, current: string): boolean {
  const previousSeparator = previous.lastIndexOf(":");
  const currentSeparator = current.lastIndexOf(":");
  return (
    previousSeparator >= 0 &&
    currentSeparator >= 0 &&
    previous.slice(0, previousSeparator) !== current.slice(0, currentSeparator)
  );
}

function safeError(error: unknown): string {
  return redact(error instanceof Error ? error.message : String(error)).slice(0, 800);
}

/** Best-effort defense in depth; provenance filtering and model instructions remain necessary. */
function redact(text: string): string {
  return text
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, "[REDACTED_SECRET]")
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, "$1 [REDACTED_SECRET]")
    .replace(/\beyJ[\w-]+\.[\w-]+\.[\w-]+\b/g, "[REDACTED_SECRET]")
    .replace(
      /(["']?(?:api[_ -]?key|access[_-]?token|refresh[_-]?token|password|client_secret)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;&]+)/gi,
      "$1[REDACTED_SECRET]",
    )
    .replace(/([?&](?:token|key|code|secret|signature|access_token)=)[^&#\s]+/gi, "$1[REDACTED_SECRET]");
}

function parseOutput(text: string, keys: string[], maxCharacters: number): Record<string, string> {
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("记忆模型未返回 JSON 对象。");
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== keys.length || keys.some((key) => typeof record[key] !== "string"))
    throw new Error(`记忆模型产物字段无效；需要 ${keys.join("、")}。`);
  const output: Record<string, string> = {};
  for (const key of keys) {
    const content = redact((record[key] as string).trim());
    if ([...content].length > maxCharacters) throw new Error(`记忆产物 ${key} 超过容量上限。`);
    output[key] = content;
  }
  return output;
}

async function readOptional(path: string, maxBytes = 512_000): Promise<string> {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(`记忆文件必须为普通文件：${path}`);
    if (info.size > maxBytes) throw new Error(`记忆文件超过 ${maxBytes} 字节：${path}`);
    return await readFile(path, "utf8");
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return "";
    throw error;
  }
}

function summaryName(record: { id: string }): string {
  return `rollout_summaries/${digest(record.id).slice(0, 24)}.md`;
}

function summaryFile(record: MemoryRecord): string {
  return [
    `session_id: ${JSON.stringify(record.id)}`,
    `source_boundary: ${JSON.stringify(record.boundary)}`,
    `updated_at: ${new Date(record.updatedAt).toISOString()}`,
    `workspace: ${JSON.stringify(record.cwd)}`,
    `title: ${JSON.stringify(record.title)}`,
    ...(record.evidencePath ? [`evidence_path: ${JSON.stringify(record.evidencePath)}`] : []),
    "",
    record.rolloutSummary,
    "",
  ].join("\n");
}

function rawFile(records: MemoryRecord[]): string {
  return [
    "# Raw memories",
    ...records.map((record) =>
      [
        `## Session ${JSON.stringify(record.id)}`,
        `workspace: ${JSON.stringify(record.cwd)}`,
        `source_boundary: ${JSON.stringify(record.boundary)}`,
        `rollout_summary: ${summaryName(record)}`,
        record.rawMemory,
      ].join("\n"),
    ),
    ...(records.length ? [] : ["No selected source memories."]),
  ].join("\n\n");
}

/** One owner per active user store. All calls share its cancellation and publication barrier. */
export class LongMemoryService {
  private readonly options: LongMemoryOptions;
  private readonly now: () => number;
  private settings?: MemorySettings;
  private pending?: Promise<void>;
  private maintenance?: Promise<void>;
  private controller?: AbortController;
  private epoch = 0;
  private usageEpoch = 0;
  private closed = false;
  private readonly generationReaders = new Map<string, number>();
  private readonly retiredGenerations = new Set<string>();
  private cleanup: Promise<void> = Promise.resolve();
  private readonly modelCalls = new Set<Promise<MemoryRunResult>>();
  private recovered = false;

  constructor(options: LongMemoryOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
  }

  private state(): LongMemoryState {
    return structuredClone(this.options.getState() ?? initialState());
  }

  private save(state: LongMemoryState): void {
    this.options.setState(structuredClone(state));
  }

  private outcome(status: LongMemoryStatus["status"], message: string): void {
    const state = this.state();
    state.outcome = status;
    state.message = message;
    state.lastRun = this.now();
    this.save(state);
  }

  configure(settings: MemorySettings): void {
    this.settings = structuredClone(settings);
    if (!settings.long || !settings.generate) {
      this.cancel();
    }
  }

  check(triggerSelection: CombinedSelection, settings: MemorySettings): Promise<void> {
    this.configure(settings);
    if (this.closed || this.maintenance || !settings.long || !settings.generate) return Promise.resolve();
    if (this.pending) return this.pending;
    const frozenSettings = structuredClone(settings);
    const frozenTrigger = structuredClone(triggerSelection);
    const controller = new AbortController();
    this.controller = controller;
    const epoch = this.epoch;
    const work = this.execute(frozenTrigger, frozenSettings, controller.signal, epoch).catch(
      (error: unknown) => {
        if (!this.closed && epoch === this.epoch) {
          this.outcome("failed", safeError(error));
        }
      },
    );
    this.pending = work.finally(() => {
      if (this.controller === controller) this.controller = undefined;
      this.pending = undefined;
    });
    return this.pending;
  }

  private cancel(): void {
    this.epoch++;
    this.controller?.abort();
  }

  async stop(): Promise<void> {
    const running = this.pending;
    this.cancel();
    await running;
    if (running && !this.closed) this.outcome("cancelled", "记忆任务已取消，保留上一份有效记忆。");
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.stop();
    await this.maintenance;
    await this.cleanup;
  }

  /** After closing and releasing foreground leases, wait for transport cancellation and filesystem cleanup. */
  async drain(): Promise<void> {
    await Promise.allSettled([...this.modelCalls]);
    await this.cleanup;
  }

  clear(): Promise<void> {
    if (this.maintenance) return this.maintenance;
    const task = this.performClear();
    this.maintenance = task.finally(() => {
      this.maintenance = undefined;
    });
    return this.maintenance;
  }

  private async performClear(): Promise<void> {
    this.usageEpoch++;
    await this.stop();
    const sources = await this.options.sources();
    const state = initialState();
    state.tombstones = Object.fromEntries(sources.map((source) => [source.id, source.boundary]));
    state.outcome = "idle";
    state.message = "长期记忆已清空；现有会话版本不会重新提取。";
    // Withdraw the published generation before deleting files, including on filesystem failure.
    this.save(state);
    this.generationReaders.clear();
    this.retiredGenerations.clear();
    await this.cleanup;
    await rm(this.options.directory, { recursive: true, force: true });
  }

  async invalidateSource(id: string): Promise<void> {
    // Hide stale summary immediately, before awaiting an abort-aware model runner.
    const previous = this.state();
    const affectsPublished = previous.activeSources.some((source) => source.id === id);
    if (!previous.records[id] && !previous.jobs[id] && !affectsPublished) return;
    previous.invalidated ||= affectsPublished;
    this.save(previous);
    await this.stop();
    const state = this.state();
    // Deletion/rewrite invalidates evidence, but only explicit clear establishes a cutoff.
    // A rewritten surviving conversation must be eligible for full re-extraction.
    delete state.records[id];
    delete state.jobs[id];
    state.invalidated ||= affectsPublished;
    this.save(state);
  }

  status(): LongMemoryStatus {
    const state = this.state();
    const status =
      this.settings?.long === false
        ? "disabled"
        : this.settings?.generate === false
          ? "paused"
          : this.pending
            ? "running"
            : (state.outcome ?? "idle");
    return {
      path: this.generationPath(state),
      running: Boolean(this.pending),
      status,
      message:
        status === "disabled"
          ? "长期记忆已关闭，已有数据保留。"
          : status === "paused"
            ? "自动生成已暂停，仍可使用已有记忆。"
            : (state.message ?? "尚未运行长期记忆。"),
      lastRun: state.lastRun,
      tokens: state.tokens,
      cost: state.cost,
      sources: this.publicSources(state),
    };
  }

  async context(): Promise<{ instructions: string[]; sources: MemorySource[]; release(): void }> {
    // The caller owns per-conversation enablement; global disable only gates new generation.
    const state = this.state();
    const generation = state.invalidated ? undefined : state.activeGeneration;
    const path = generation ? this.generationPath(state) : this.options.directory;
    if (generation) this.generationReaders.set(generation, (this.generationReaders.get(generation) ?? 0) + 1);
    let released = false;
    const release = () => {
      if (released || !generation) return;
      released = true;
      const count = this.generationReaders.get(generation) ?? 0;
      if (count > 1) this.generationReaders.set(generation, count - 1);
      else this.generationReaders.delete(generation);
      this.pruneRetired();
    };
    try {
      const summary = generation ? await readOptional(join(path, "memory_summary.md"), 10_000) : "";
      return {
        instructions: longMemoryInstructions(path, join(this.options.directory, "memory_notes.md"), summary),
        sources: state.invalidated ? [] : this.publicSources(state),
        release,
      };
    } catch (error) {
      release();
      throw error;
    }
  }

  private pruneRetired(): void {
    for (const generation of this.retiredGenerations) {
      if (this.generationReaders.has(generation)) continue;
      this.retiredGenerations.delete(generation);
      this.cleanup = this.cleanup.then(async () => {
        await rm(join(this.options.directory, "generations", generation), {
          recursive: true,
          force: true,
        }).catch(() => {});
      });
    }
  }

  /** Called only for sources actually read by the main agent, not merely injected navigation. */
  recordUsage(ids: string[]): void {
    const state = this.state();
    for (const id of new Set(ids)) {
      const record = state.records[id];
      if (!record) continue;
      record.usageCount++;
      record.lastUsage = this.now();
    }
    this.save(state);
  }

  private generationPath(state: LongMemoryState): string {
    return state.activeGeneration
      ? join(this.options.directory, "generations", state.activeGeneration)
      : this.options.directory;
  }

  private publicSources(state: LongMemoryState): MemorySource[] {
    return state.activeSources.flatMap(({ id }) => {
      const record = state.records[id];
      return record
        ? [
            {
              sessionId: id,
              title: record.title,
              workspace: record.cwd,
              summaryPath: join(this.generationPath(state), summaryName(record)),
            },
          ]
        : [];
    });
  }

  private assertCurrent(signal: AbortSignal, epoch: number): void {
    if (signal.aborted || this.closed || epoch !== this.epoch) throw new Error("记忆任务已取消。");
  }

  private async model(request: MemoryRunRequest, epoch: number): Promise<string> {
    this.assertCurrent(request.signal, epoch);
    let abort: (() => void) | undefined;
    const cancelled = new Promise<never>((_, reject) => {
      abort = () => reject(new Error("记忆任务已取消。"));
      request.signal.addEventListener("abort", abort, { once: true });
    });
    const usageEpoch = this.usageEpoch;
    // An aborted request can report billed usage after cancellation; count it without publishing its result.
    // A clear or close invalidates this accounting callback as well.
    const operation = Promise.resolve()
      .then(() => {
        request.signal.throwIfAborted();
        return this.options.run(request);
      })
      .then(
        (result) => {
          if (!this.closed && usageEpoch === this.usageEpoch) this.addUsage(result.usage);
          return result;
        },
        (error: unknown) => {
          if (
            !this.closed &&
            usageEpoch === this.usageEpoch &&
            error &&
            typeof error === "object" &&
            "usage" in error
          )
            this.addUsage(error.usage as MemoryRunResult["usage"]);
          throw error;
        },
      );
    this.modelCalls.add(operation);
    void operation.finally(() => this.modelCalls.delete(operation)).catch(() => {});
    try {
      const result = await Promise.race([operation, cancelled]);
      this.assertCurrent(request.signal, epoch);
      return result.text;
    } finally {
      if (abort) request.signal.removeEventListener("abort", abort);
    }
  }

  private addUsage(usage: MemoryRunResult["usage"]): void {
    if (!usage || !Number.isFinite(usage.tokens)) return;
    const state = this.state();
    state.tokens += Math.max(0, usage.tokens);
    state.cost =
      state.cost === null || usage.cost === null || !Number.isFinite(usage.cost)
        ? null
        : state.cost + Math.max(0, usage.cost);
    this.save(state);
  }

  private async execute(
    trigger: CombinedSelection,
    settings: MemorySettings,
    signal: AbortSignal,
    epoch: number,
  ): Promise<void> {
    const base = settings.modelMode === "manual" ? settings.selection : trigger;
    if (!base) throw new Error("长期记忆尚未指定模型。请选择模型或切换为跟随会话。");
    const extractModel = structuredClone(settings.extractSelection ?? base);
    const consolidateModel = structuredClone(settings.consolidateSelection ?? base);
    this.outcome("running", "正在检查历史会话。");
    if (!this.recovered) {
      await this.recoverTemporaryFiles();
      this.assertCurrent(signal, epoch);
      this.recovered = true;
    }
    const sources = await this.options.sources();
    this.assertCurrent(signal, epoch);
    const now = this.now();
    const byId = new Map(sources.map((source) => [source.id, source]));
    let state = this.state();
    for (const id of Object.keys(state.records)) {
      if (!byId.has(id) || byId.get(id)?.eligible === false) {
        delete state.records[id];
        delete state.jobs[id];
        state.invalidated ||= state.activeSources.some((source) => source.id === id);
      }
    }
    this.save(state);
    const window = sources
      .filter((source) => source.eligible !== false && source.updatedAt >= now - settings.maxAgeDays * DAY)
      .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))
      .slice(0, 5_000);
    const stale = window.filter((source) => {
      const job = state.jobs[source.id];
      return (
        state.tombstones[source.id] !== source.boundary &&
        (!job || job.boundary !== source.boundary || job.version !== PIPELINE_VERSION || !job.completed)
      );
    });
    const eligible = stale.filter((source) => {
      const job = state.jobs[source.id];
      return (
        !source.active &&
        source.updatedAt <= now - settings.minIdleHours * HOUR &&
        (!job ||
          job.boundary !== source.boundary ||
          job.version !== PIPELINE_VERSION ||
          (job.attempts < MAX_ATTEMPTS && job.retryAt <= now))
      );
    });
    const waitingFailure = stale.find((source) => {
      const job = state.jobs[source.id];
      return job?.boundary === source.boundary && job.lastError && !eligible.includes(source);
    });
    let failures = waitingFailure ? 1 : 0;
    if (waitingFailure)
      this.outcome("failed", state.jobs[waitingFailure.id].lastError ?? "提取失败，等待重试。");
    let completed = 0;
    for (const source of eligible.slice(0, settings.maxRolloutsPerBatch)) {
      this.assertCurrent(signal, epoch);
      state = this.state();
      const oldJob = state.jobs[source.id];
      const attempts =
        oldJob?.boundary === source.boundary && oldJob.version === PIPELINE_VERSION ? oldJob.attempts : 0;
      state.jobs[source.id] = {
        boundary: source.boundary,
        version: PIPELINE_VERSION,
        attempts,
        retryAt: 0,
        completed: false,
      };
      this.save(state);
      try {
        const clearedBoundary = state.tombstones[source.id];
        const evidence = redact(await source.read(clearedBoundary));
        this.assertCurrent(signal, epoch);
        const characters = [...evidence];
        const bounded =
          characters.length > MAX_EVIDENCE_CHARACTERS
            ? `[Earlier evidence omitted due to input limit.]\n${characters.slice(-MAX_EVIDENCE_CHARACTERS).join("")}`
            : evidence;
        const result = evidence.trim()
          ? parseOutput(
              await this.model(
                {
                  stage: "extract",
                  prompt: extractionPrompt(
                    { ...source, read: undefined, clearedBoundary, processingVersion: PIPELINE_VERSION },
                    bounded,
                  ),
                  model: extractModel,
                  signal,
                },
                epoch,
              ),
              ["rawMemory", "rolloutSummary"],
              12_000,
            )
          : { rawMemory: "", rolloutSummary: "" };
        if (Boolean(result.rawMemory) !== Boolean(result.rolloutSummary))
          throw new Error("提取产物不完整；rawMemory 和 rolloutSummary 必须同时有内容或同时为空。");
        this.assertCurrent(signal, epoch);
        state = this.state();
        state.jobs[source.id].completed = true;
        if (
          !evidence.trim() &&
          clearedBoundary &&
          differentSourceGeneration(clearedBoundary, source.boundary)
        )
          state.tombstones[source.id] = source.boundary;
        if (!result.rawMemory || !result.rolloutSummary) {
          delete state.records[source.id];
          if (state.activeSources.some(({ id }) => id === source.id)) state.invalidated = true;
        } else {
          const old = state.records[source.id];
          state.records[source.id] = {
            id: source.id,
            title: source.title,
            cwd: source.cwd,
            boundary: source.boundary,
            updatedAt: source.updatedAt,
            evidencePath: source.evidencePath,
            generatedAt: this.now(),
            rawMemory: result.rawMemory,
            rolloutSummary: result.rolloutSummary,
            usageCount: old?.usageCount ?? 0,
            lastUsage: old?.lastUsage,
          };
        }
        this.save(state);
        completed++;
      } catch (error) {
        this.assertCurrent(signal, epoch);
        failures++;
        state = this.state();
        const message = `会话 ${source.title} 提取失败：${safeError(error)}`;
        state.jobs[source.id].attempts++;
        state.jobs[source.id].retryAt = this.now() + HOUR;
        state.jobs[source.id].lastError = message;
        this.save(state);
        this.outcome("failed", message);
      }
    }
    this.assertCurrent(signal, epoch);
    state = this.state();
    const ranked = Object.values(state.records)
      .filter((record) => (record.lastUsage ?? record.updatedAt) >= now - MAX_UNUSED_DAYS * DAY)
      .sort(
        (a, b) =>
          b.usageCount - a.usageCount ||
          (b.lastUsage ?? b.updatedAt) - (a.lastUsage ?? a.updatedAt) ||
          b.updatedAt - a.updatedAt ||
          b.id.localeCompare(a.id),
      );
    const selected: MemoryRecord[] = [];
    let characterBudget = MAX_SELECTED_CHARACTERS;
    for (const record of ranked.slice(0, MAX_SELECTED)) {
      const size = [...record.rawMemory, ...record.rolloutSummary].length;
      if (size > characterBudget) continue;
      characterBudget -= size;
      selected.push(record);
    }
    selected.sort((a, b) => a.id.localeCompare(b.id));
    const selectedIds = new Set(selected.map(({ id }) => id));
    if (state.activeSources.some(({ id }) => !selectedIds.has(id))) {
      state.invalidated = true;
      this.save(state);
    }
    const notes = redact(await readOptional(join(this.options.directory, "memory_notes.md"), 32_000));
    this.assertCurrent(signal, epoch);
    const rawMemories = rawFile(selected);
    const summaries = selected.map((record) => ({ path: summaryName(record), content: summaryFile(record) }));
    const fingerprint = digest(JSON.stringify({ version: PIPELINE_VERSION, rawMemories, summaries, notes }));
    const oldPath = this.generationPath(state);
    const previousMemory = state.activeGeneration ? await readOptional(join(oldPath, "MEMORY.md")) : "";
    const previousSummary = state.activeGeneration
      ? await readOptional(join(oldPath, "memory_summary.md"), 10_000)
      : "";
    this.assertCurrent(signal, epoch);
    if (fingerprint === state.activeFingerprint && previousMemory && previousSummary) {
      const expectedInputs = [{ path: "raw_memories.md", content: `${rawMemories}\n` }, ...summaries];
      const actualInputs = await Promise.all(
        expectedInputs.map(({ path, content }) =>
          readOptional(join(oldPath, path), Math.max(512_000, Buffer.byteLength(content, "utf8"))),
        ),
      );
      this.assertCurrent(signal, epoch);
      if (actualInputs.some((content, index) => content !== expectedInputs[index].content)) {
        await this.publish(
          { memory: previousMemory.trim(), summary: previousSummary.trim() },
          selected,
          fingerprint,
          rawMemories,
          summaries,
          signal,
          epoch,
        );
        this.assertCurrent(signal, epoch);
      }
      if (state.invalidated) {
        const current = this.state();
        current.invalidated = false;
        this.save(current);
      }
      if (!failures) {
        const awaitingIdle =
          !eligible.length &&
          stale.some((source) => source.active || source.updatedAt > now - settings.minIdleHours * HOUR);
        this.outcome(
          awaitingIdle ? "waiting-idle" : "unchanged",
          awaitingIdle
            ? "新的历史会话尚未达到空闲门槛，已有记忆继续可用。"
            : "输入未变化，无需调用整合模型。",
        );
      }
      return;
    }
    if (!selected.length && !notes && !state.activeGeneration) {
      if (!failures)
        this.outcome(
          completed ? "unchanged" : stale.length ? "waiting-idle" : "no-candidates",
          completed
            ? "已检查会话，没有值得保留的新内容。"
            : stale.length
              ? "历史会话尚未达到空闲门槛，或正在等待失败重试。"
              : "没有符合条件的历史会话。",
        );
      return;
    }
    if (state.consolidationRetryAt && state.consolidationRetryAt > now) {
      this.outcome("failed", "上次整合失败，等待一小时退避后重试；上一份有效产物保留。");
      return;
    }
    const changes = {
      added: selected.filter(({ id }) => !state.activeSources.some((old) => old.id === id)).map(summaryName),
      changed: selected
        .filter(({ id, boundary }) =>
          state.activeSources.some((old) => old.id === id && old.boundary !== boundary),
        )
        .map(summaryName),
      removed: state.activeSources.filter(({ id }) => !selectedIds.has(id)).map(summaryName),
    };
    try {
      const output = parseOutput(
        await this.model(
          {
            stage: "consolidate",
            prompt: consolidationPrompt({
              previousMemory,
              previousSummary,
              rawMemories,
              summaries,
              changes,
              notes,
            }),
            model: consolidateModel,
            signal,
          },
          epoch,
        ),
        ["memory", "summary"],
        100_000,
      );
      if (!output.memory || !output.summary || Buffer.byteLength(output.summary, "utf8") > 9_000)
        throw new Error("整合产物为空，或摘要超过 9,000 UTF-8 字节。");
      const filenames = new Set(summaries.map(({ path }) => path));
      for (const match of `${output.memory}\n${output.summary}`.matchAll(/rollout_summaries\/[\w.-]+\.md/g)) {
        if (!filenames.has(match[0])) throw new Error(`整合产物引用不存在或已删除的来源：${match[0]}`);
      }
      this.assertCurrent(signal, epoch);
      await this.publish(output, selected, fingerprint, rawMemories, summaries, signal, epoch);
      this.assertCurrent(signal, epoch);
      this.outcome(
        "success",
        `记忆已更新；本批提取 ${completed} 个会话${failures ? `，${failures} 个失败待重试` : ""}。`,
      );
    } catch (error) {
      this.assertCurrent(signal, epoch);
      state = this.state();
      state.consolidationRetryAt = this.now() + HOUR;
      this.save(state);
      throw error;
    }
  }

  private async publish(
    output: Record<string, string>,
    selected: MemoryRecord[],
    fingerprint: string,
    rawMemories: string,
    summaries: { path: string; content: string }[],
    signal: AbortSignal,
    epoch: number,
  ): Promise<void> {
    const generation = randomUUID();
    const root = join(this.options.directory, "generations");
    const temporary = join(root, `.pending-${generation}`);
    const destination = join(root, generation);
    try {
      await mkdir(join(temporary, "rollout_summaries"), { recursive: true });
      this.assertCurrent(signal, epoch);
      const files = [
        { path: "MEMORY.md", content: `${output.memory}\n` },
        { path: "memory_summary.md", content: `${output.summary}\n` },
        { path: "raw_memories.md", content: `${rawMemories}\n` },
        ...summaries,
      ];
      const results = await Promise.allSettled(
        files.map(async ({ path, content }) => {
          const file = await open(join(temporary, path), "wx", 0o600);
          try {
            await file.writeFile(content, "utf8");
            await file.sync();
          } finally {
            await file.close();
          }
        }),
      );
      const failed = results.find((result) => result.status === "rejected");
      if (failed?.status === "rejected") throw failed.reason;
      this.assertCurrent(signal, epoch);
      syncDirectory(join(temporary, "rollout_summaries"));
      syncDirectory(temporary);
      await rename(temporary, destination);
      syncDirectory(root);
      syncDirectory(this.options.directory);
      syncDirectory(dirname(this.options.directory));
      this.assertCurrent(signal, epoch);
      const state = this.state();
      const previous = state.activeGeneration;
      state.activeGeneration = generation;
      state.activeFingerprint = fingerprint;
      state.activeSources = selected.map(({ id, boundary }) => ({ id, boundary }));
      state.invalidated = false;
      state.lastSuccess = this.now();
      state.consolidationRetryAt = undefined;
      // Expired raw rows are discarded only after successful deletion propagation. Jobs retain watermarks.
      const selectedIds = new Set(selected.map(({ id }) => id));
      for (const [id, record] of Object.entries(state.records)) {
        if (
          !selectedIds.has(id) &&
          (record.lastUsage ?? record.updatedAt) < this.now() - MAX_UNUSED_DAYS * DAY
        )
          delete state.records[id];
      }
      this.save(state);
      // Historical source files remain immutable; only superseded generated artifacts are pruned.
      if (previous) this.retiredGenerations.add(previous);
      this.pruneRetired();
    } catch (error) {
      await rm(temporary, { recursive: true, force: true }).catch(() => {});
      if (this.state().activeGeneration !== generation)
        await rm(destination, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
  }

  private async recoverTemporaryFiles(): Promise<void> {
    const root = join(this.options.directory, "generations");
    try {
      for (const entry of await readdir(root, { withFileTypes: true })) {
        if (/^\.pending-[0-9a-f-]{36}$/.test(entry.name))
          await rm(join(root, entry.name), { recursive: true, force: true });
      }
    } catch (error) {
      if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT") throw error;
    }
  }
}
