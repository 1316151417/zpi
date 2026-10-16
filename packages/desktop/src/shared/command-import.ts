export type CommandImportMode = "symlink" | "copy";
export type CommandImportSkipReason = "targetExists" | "sameNameExists";

export interface CommandImportCandidate {
  id: string;
  revision: string;
  name: string;
  description?: string;
  argumentHint?: string;
  sourcePath: string;
  relativePath: string;
  importable: boolean;
  skipReason?: CommandImportSkipReason;
}

export interface CommandImportSource {
  id: string;
  label: string;
  scope: "global" | "project";
  path: string;
  commands: CommandImportCandidate[];
}

export interface CommandImportDiscovery {
  scanId: string;
  targetDirectory: string;
  targetScope: "global" | "project";
  projectAvailable: boolean;
  sources: CommandImportSource[];
  warnings: string[];
}

export interface CommandImportRequest {
  scanId: string;
  mode: CommandImportMode;
  selections: { id: string; revision: string }[];
}

export interface CommandImportItemResult {
  id: string;
  name: string;
  sourcePath: string;
  status: "imported" | "skipped" | "failed";
  skipReason?: CommandImportSkipReason;
  method?: CommandImportMode;
  error?: string;
}

export interface CommandImportResult {
  importedCount: number;
  skippedCount: number;
  failedCount: number;
  items: CommandImportItemResult[];
}
