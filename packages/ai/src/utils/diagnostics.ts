// Adapted from Pi cd34e17ff039502f3664d8363b3c0a23f93a2ca3.
// Copyright (c) 2025 Mario Zechner. MIT: THIRD_PARTY_NOTICES.md.
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

export function formatThrownValue(value: unknown): string {
  if (value instanceof Error) return value.message || value.name;
  if (typeof value === "string") return value;
  return String(value);
}

export function extractDiagnosticError(error: unknown): DiagnosticErrorInfo {
  if (!(error instanceof Error)) return { name: "ThrownValue", message: formatThrownValue(error) };
  const code = (error as Error & { code?: unknown }).code;
  return {
    name: error.name || undefined,
    message: error.message || error.name,
    stack: error.stack,
    code: typeof code === "string" || typeof code === "number" ? code : undefined,
  };
}

export function createAssistantMessageDiagnostic(
  type: string,
  error: unknown,
  details?: JsonObject,
): AssistantMessageDiagnostic {
  return { type, timestamp: Date.now(), error: extractDiagnosticError(error), details };
}

export function appendAssistantMessageDiagnostic<T extends { diagnostics?: AssistantMessageDiagnostic[] }>(
  message: T,
  diagnostic: AssistantMessageDiagnostic,
): void {
  message.diagnostics = [...(message.diagnostics ?? []), diagnostic];
}
