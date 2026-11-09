export interface CustomCommand {
  /** Stable relative Markdown path, such as tools/review.md. */
  id: string;
  name: string;
  filePath: string;
  /** Present only for a link recorded by the explicit importer. */
  importedSourcePath?: string;
  /** Registered local link exists, but its source cannot currently be read. */
  unreadable?: true;
  prompt: string;
  description?: string;
  argumentHint?: string;
  skills?: string[];
  disableNonInteractive?: boolean;
  enabled: boolean;
  revision: string;
}
export interface CustomCommandInput {
  name: string;
  prompt: string;
  description?: string;
  argumentHint?: string;
}
export interface CustomCommandUpdate extends Omit<CustomCommandInput, "name"> {
  id: string;
  expectedRevision: string;
  name?: string;
  /** Explicit approval to edit the registered external source rather than the local link. */
  confirmLinkedSource?: boolean;
  expectedSourcePath?: string;
}
export interface CustomCommandDelete {
  id: string;
  expectedRevision: string;
}
export interface CustomCommandSetEnabled {
  id: string;
  enabled: boolean;
}
export interface CustomCommandDiagnostic {
  code: string;
  message: string;
  path?: string;
}
/** Session discovery keeps metadata and policy; template text is read only on invocation. */
export type CustomCommandSummary = Omit<CustomCommand, "prompt" | "revision" | "skills">;

export interface CustomCommandsList<T = CustomCommand> {
  subagents?: { name: string; description: string }[];
  commands: T[];
  diagnostics: CustomCommandDiagnostic[];
  directoryPath: string;
}
