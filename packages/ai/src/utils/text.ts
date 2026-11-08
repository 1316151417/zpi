// Adapted from Pi cd34e17ff039502f3664d8363b3c0a23f93a2ca3.
// Copyright (c) 2025 Mario Zechner. MIT: licenses/third-party-notices.txt.
import type { SystemMessage } from "../types.ts";
import { contentText } from "./transcript.ts";

/**
 * Shared wire representation of named context changes, regardless of provider role.
 */
export function renderSystemMessageUpdate(message: SystemMessage): string {
  const parts: string[] = [];
  const text = contentText(message.content);
  if (text.length > 0) parts.push(text);
  for (const [name, value] of Object.entries(message.sections ?? {})) {
    parts.push(
      value === null
        ? `Context block ${JSON.stringify(name)} is withdrawn. All earlier versions of this block no longer apply.`
        : `Context block ${JSON.stringify(name)} replaces all earlier versions of this block. Apply it until a later context update replaces or withdraws it, including updates carried in user messages:\n\n${value}`,
    );
  }
  return parts.join("\n\n");
}
