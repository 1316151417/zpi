import type { CombinedSelection } from "./bridge.ts";

export interface MemorySettings {
  short: boolean;
  long: boolean;
  generate: boolean;
  modelMode: "follow" | "manual";
  selection: CombinedSelection | null;
  extractSelection: CombinedSelection | null;
  consolidateSelection: CombinedSelection | null;
  minIdleHours: number;
  maxAgeDays: number;
  maxRolloutsPerBatch: number;
}

export const defaultMemorySettings: Readonly<MemorySettings> = {
  short: false,
  long: false,
  generate: true,
  modelMode: "follow",
  selection: null,
  extractSelection: null,
  consolidateSelection: null,
  minIdleHours: 6,
  maxAgeDays: 10,
  maxRolloutsPerBatch: 2,
};

/** Compatibility for configurations saved before memory modes became mutually exclusive. */
export function exclusiveMemoryMode<T extends { short: boolean; long: boolean }>(value: T): T {
  return value.short && value.long ? { ...value, short: false } : value;
}

export const memorySettingLimits = {
  minIdleHours: { min: 1, max: 168 },
  maxAgeDays: { min: 1, max: 365 },
  maxRolloutsPerBatch: { min: 1, max: 16 },
} as const;

export interface MemoryFileStatus {
  scope: "user" | "project";
  path: string;
  exists: boolean;
  count: number;
  characters: number;
  diagnostics: string[];
}

export interface MemorySource {
  sessionId: string;
  title: string;
  workspace: string;
  summaryPath?: string;
}

export interface LongMemoryStatus {
  path: string;
  running: boolean;
  status:
    | "disabled"
    | "paused"
    | "idle"
    | "no-candidates"
    | "waiting-idle"
    | "unchanged"
    | "running"
    | "success"
    | "failed"
    | "cancelled";
  message: string;
  lastRun?: number;
  tokens: number;
  cost: number | null;
  sources: MemorySource[];
}

export interface MemoryStatus {
  shortFiles: MemoryFileStatus[];
  long: LongMemoryStatus;
  usedSources?: MemorySource[];
}
