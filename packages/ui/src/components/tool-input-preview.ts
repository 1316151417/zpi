// Adapted from ZCode streaming-tool-input-preview.ts and toolCallRowAdapter.ts
// (872ad96, Apache-2.0). Pi's edit fields use oldText/newText instead of old_string/new_string.
import type { ToolView } from "./tool-presentation.ts";

const stringFields = [
  "file_path",
  "filePath",
  "path",
  "target_path",
  "targetPath",
  "filename",
  "file",
  "content",
  "new_string",
  "newString",
  "new_text",
  "newText",
  "old_string",
  "oldString",
  "old_text",
  "oldText",
  "command",
  "description",
  "title",
  "pattern",
  "replacement",
  "plan",
  "name",
  "script",
] as const;

/** No input yet is distinct from a real, complete empty tool argument object. */
export function toolInputPreview(block: ToolView): Record<string, unknown> | undefined {
  try {
    const input: unknown = JSON.parse(block.argsText);
    if (input && typeof input === "object" && !Array.isArray(input)) {
      const record = input as Record<string, unknown>;
      return block.status === "preparing" && Object.keys(record).length === 0 ? undefined : record;
    }
    return undefined;
  } catch {
    const input: Record<string, string> = {};
    for (const key of stringFields) {
      const value = readPartialString(block.argsText, key);
      if (value !== undefined) input[key] = value;
    }
    return Object.keys(input).length ? input : undefined;
  }
}

function readPartialString(raw: string, key: string): string | undefined {
  const match = new RegExp(`"${key}"\\s*:\\s*"`).exec(raw);
  if (!match) return undefined;
  let encoded = "";
  let escaped = false;
  let closed = false;
  for (let index = match.index + match[0].length; index < raw.length; index++) {
    const char = raw[index];
    if (escaped) {
      encoded += `\\${char}`;
      escaped = false;
    } else if (char === "\\") {
      escaped = true;
    } else if (char === '"') {
      closed = true;
      break;
    } else {
      encoded += char;
    }
  }
  if (escaped) encoded += "\\";
  // A trailing slash or unfinished Unicode escape must not leak into the preview.
  const normalized = closed ? encoded : encoded.replace(/\\u[0-9a-fA-F]{0,3}$/, "").replace(/\\$/, "");
  try {
    return JSON.parse(`"${normalized}"`) as string;
  } catch {
    return normalized
      .replace(/\\n/g, "\n")
      .replace(/\\r/g, "\r")
      .replace(/\\t/g, "\t")
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, "\\");
  }
}
