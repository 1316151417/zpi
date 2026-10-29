// Adapted from Pi cd34e17ff039502f3664d8363b3c0a23f93a2ca3.
// Copyright (c) 2025 Mario Zechner. MIT: licenses/third-party-notices.txt.
import type { JsonObject } from "../types.ts";

export interface DiagnosticErrorInfo {
  name?: string;
  message: string;
  stack?: string;
  code?: string | number;
}

export interface AssistantMessageDiagnostic {
  type: string;
  timestamp: number;
  error?: DiagnosticErrorInfo;
  details?: JsonObject;
}

export function appendAssistantMessageDiagnostic<T extends { diagnostics?: AssistantMessageDiagnostic[] }>(
  message: T,
  diagnostic: AssistantMessageDiagnostic,
): void {
  message.diagnostics = [...(message.diagnostics ?? []), diagnostic];
}
