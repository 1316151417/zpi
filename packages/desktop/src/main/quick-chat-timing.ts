import { constants } from "node:fs";
import fs from "node:fs/promises";
import { join } from "node:path";

const kindValues = ["open", "new", "warmup", "hide", "event"] as const;
const modeValues = ["cold", "loading", "warm"] as const;
const outcomeValues = ["shown", "hidden", "failed", "ready", "cancelled", "timeout"] as const;
const stageValues = [
  "start",
  "shortcut-register",
  "shortcut-received",
  "shortcut-ignored",
  "shortcut-unregister",
  "open-request",
  "new-coalesced",
  "snapshot-sent",
  "composer-probe",
  "draft-offered",
  "draft-taken",
  "composer-reply",
  "composer-timeout",
  "renderer-commit",
  "renderer-ack",
  "renderer-ack-ignored",
  "native-blur",
  "expiry-ready",
  "reset-start",
  "reset-dispatched",
  "host-stop-ready",
  "host-dispose-ready",
  "host-selection-ready",
  "host-published",
  "snapshot-received",
  "snapshot-bounds",
  "reset-ready",
  "session-frame-wait",
  "session-frame-ready",
  "window-created",
  "window-loaded",
  "window-ready",
  "renderer-ready",
  "geometry",
  "show",
  "native-show",
  "focus",
  "native-focus",
  "native-keydown",
  "settings",
  "renderer-focus",
  "renderer-frame",
  "blur-focused",
  "blur-unfocused",
  "blur-ignored",
  "space-changed",
  "native-hidden",
  "hide-ignored",
  "toggle-hide",
  "ipc-hide",
  "native-close",
  "program-hide",
  "finished",
] as const;

export type QuickChatKind = (typeof kindValues)[number];
export type QuickChatMode = (typeof modeValues)[number];
export type QuickChatOutcome = (typeof outcomeValues)[number];
export type QuickChatStage = (typeof stageValues)[number];

export interface QuickChatTrace {
  readonly id: number;
  mark(stage: QuickChatStage, state?: QuickChatTimingState): void;
  finish(outcome: QuickChatOutcome): void;
}

export interface QuickChatTimingState {
  visible: boolean;
  focused: boolean;
  expanded: boolean;
  intent?: boolean;
  epoch?: number;
  opening?: number;
  openingPhase?: "preparing" | "presenting";
  resetting?: boolean;
  sessionId?: string;
  version?: number;
  rendererVersion?: number;
  waiters?: number;
  probe?: number;
  windowId?: number;
  binding?: string;
  registered?: boolean;
  registrationVersion?: number;
}

export const maxQuickChatTimingRecords = 64;
export const maxQuickChatTimingBytes = 128 * 1024;
export const maxQuickChatTimingActive = 64;

const kinds = new Set<unknown>(kindValues);
const modes = new Set<unknown>(modeValues);
const outcomes = new Set<unknown>(outcomeValues);
const stages = new Set<unknown>(stageValues);

interface TimingRecord {
  id: number;
  at: number;
  kind: QuickChatKind;
  mode: QuickChatMode;
  outcome: QuickChatOutcome;
  stages: { stage: QuickChatStage; ms: number; state?: QuickChatTimingState }[];
}

function copyState(state: QuickChatTimingState | undefined): QuickChatTimingState | undefined {
  if (!state || typeof state !== "object") return undefined;
  try {
    // Read only own data properties; do not invoke getters or retain the caller's object/toJSON.
    const visible = Object.getOwnPropertyDescriptor(state, "visible")?.value;
    const focused = Object.getOwnPropertyDescriptor(state, "focused")?.value;
    const expanded = Object.getOwnPropertyDescriptor(state, "expanded")?.value;
    if (typeof visible !== "boolean" || typeof focused !== "boolean" || typeof expanded !== "boolean")
      return undefined;
    const result: QuickChatTimingState = { visible, focused, expanded };
    for (const key of ["intent", "resetting", "registered"] as const) {
      const value = Object.getOwnPropertyDescriptor(state, key)?.value;
      if (typeof value === "boolean") result[key] = value;
    }
    for (const key of [
      "epoch",
      "opening",
      "version",
      "rendererVersion",
      "waiters",
      "probe",
      "windowId",
      "registrationVersion",
    ] as const) {
      const value = Object.getOwnPropertyDescriptor(state, key)?.value;
      if (Number.isSafeInteger(value) && value >= 0) result[key] = value;
    }
    const sessionId = Object.getOwnPropertyDescriptor(state, "sessionId")?.value;
    const openingPhase = Object.getOwnPropertyDescriptor(state, "openingPhase")?.value;
    if (openingPhase === "preparing" || openingPhase === "presenting") result.openingPhase = openingPhase;
    if (typeof sessionId === "string" && /^[a-zA-Z0-9_-]{1,80}$/.test(sessionId))
      result.sessionId = sessionId;
    const binding = Object.getOwnPropertyDescriptor(state, "binding")?.value;
    if (typeof binding === "string" && /^[a-zA-Z0-9+[\],.;/=' -]{1,80}$/.test(binding))
      result.binding = binding;
    return result;
  } catch {
    // Invalid or revoked proxies must not interrupt the window operation either.
  }
  return undefined;
}

/** Opt-in local diagnostics: no text payloads, wall-clock times, network, or timers. */
export class QuickChatTiming {
  private readonly directory: string;
  private readonly enabled: boolean;
  private readonly now: () => number;
  private readonly records: TimingRecord[] = [];
  private readonly active = new Set<number>();
  private nextId = 1;
  private dirty = false;
  private pending: Promise<void> | undefined;

  constructor(dataDir: string, enabled = false, now: () => number = () => performance.now()) {
    this.directory = join(dataDir, "agent", "logs");
    this.enabled = enabled === true;
    this.now = now;
  }

  start(kind: QuickChatKind, mode: QuickChatMode): QuickChatTrace | undefined {
    if (
      !this.enabled ||
      !kinds.has(kind) ||
      !modes.has(mode) ||
      this.active.size >= maxQuickChatTimingActive ||
      !Number.isSafeInteger(this.nextId)
    )
      return undefined;
    const id = this.nextId++;
    this.active.add(id);
    const started = this.readClock();
    const marks: TimingRecord["stages"] = [{ stage: "start", ms: 0 }];
    const marked = new Set<QuickChatStage>(["start"]);
    const mark = (stage: QuickChatStage, state?: QuickChatTimingState) => {
      if (!this.active.has(id) || !stages.has(stage) || marked.has(stage)) return;
      const elapsed = this.readClock() - started;
      const previous = marks[marks.length - 1].ms;
      const ms = Number.isFinite(elapsed)
        ? Math.max(previous, Math.min(Number.MAX_SAFE_INTEGER, elapsed))
        : previous;
      const snapshot = copyState(state);
      marks.push({ stage, ms: Math.round(ms * 1000) / 1000, ...(snapshot ? { state: snapshot } : {}) });
      marked.add(stage);
    };
    return Object.freeze({
      id,
      mark: (stage: QuickChatStage, state?: QuickChatTimingState) => {
        // The final timestamp always belongs to finish, never a caller-supplied early mark.
        if (stage !== "finished") mark(stage, state);
      },
      finish: (outcome: QuickChatOutcome) => {
        if (!this.active.has(id) || !outcomes.has(outcome)) return;
        mark("finished");
        this.active.delete(id);
        this.records.push({ id, at: started, kind, mode, outcome, stages: marks });
        if (this.records.length > maxQuickChatTimingRecords) this.records.shift();
        this.dirty = true;
        this.scheduleWrite();
      },
    });
  }

  /** Wait for queued writes; calling again also retries a previous best-effort failure. */
  async flush(): Promise<void> {
    if (!this.enabled || !this.records.length) return;
    if (!this.pending) {
      this.dirty = true;
      this.scheduleWrite();
    }
    while (this.pending) await this.pending;
  }

  private readClock(): number {
    try {
      const value = this.now();
      return Number.isFinite(value) ? value : 0;
    } catch {
      return 0;
    }
  }

  private scheduleWrite(): void {
    if (this.pending) return;
    // Defer even serialization until after the opening/focusing call stack has returned.
    this.pending = Promise.resolve()
      .then(async () => {
        while (this.dirty) {
          this.dirty = false;
          try {
            await this.writeRecords();
          } catch {
            // Diagnostics must not affect quick chat or leak exception text to other logs.
          }
        }
      })
      .finally(() => {
        this.pending = undefined;
        if (this.dirty) this.scheduleWrite();
      });
  }

  private async writeRecords(): Promise<void> {
    // Only this process's allowlisted records are retained; never read arbitrary existing log data.
    let contents = `${JSON.stringify(this.records)}\n`;
    while (Buffer.byteLength(contents) > maxQuickChatTimingBytes && this.records.length) {
      this.records.shift();
      contents = `${JSON.stringify(this.records)}\n`;
    }
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    await fs.chmod(this.directory, 0o700);
    const file = await fs.open(
      join(this.directory, "quick-chat-timing.json"),
      constants.O_WRONLY | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
      0o600,
    );
    try {
      const info = await file.stat();
      if (!info.isFile() || info.nlink !== 1) return;
      await file.chmod(0o600);
      await file.truncate(0);
      await file.writeFile(contents);
    } finally {
      await file.close();
    }
  }
}
