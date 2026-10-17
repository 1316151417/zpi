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

interface ParsedInput {
  raw: string;
  complete?: Record<string, unknown>;
  preview?: Record<string, unknown>;
  previewReady: boolean;
}
// Reducer blocks retain their identity until changed. Weak keys release parsed
// payloads with evicted views; the raw guard also handles callers mutating a block.
const parsedInputs = new WeakMap<ToolView, ParsedInput>();

function parsedInput(block: ToolView): ParsedInput {
  const cached = parsedInputs.get(block);
  if (cached?.raw === block.argsText) return cached;
  const parsed: ParsedInput = { raw: block.argsText, previewReady: false };
  try {
    const input: unknown = JSON.parse(block.argsText);
    if (input && typeof input === "object" && !Array.isArray(input))
      parsed.complete = input as Record<string, unknown>;
    parsed.preview = parsed.complete;
    parsed.previewReady = true;
  } catch {
    // Recover previews lazily: command classification needs complete JSON only.
  }
  parsedInputs.set(block, parsed);
  return parsed;
}

export function completeToolInput(block: ToolView): Record<string, unknown> | undefined {
  return parsedInput(block).complete;
}

/** No input yet is distinct from a real, complete empty tool argument object. */
export function toolInputPreview(block: ToolView): Record<string, unknown> | undefined {
  const parsed = parsedInput(block);
  if (!parsed.previewReady) {
    const input: Record<string, string> = {};
    for (const key of stringFields) {
      const value = readPartialString(block.argsText, key);
      if (value !== undefined) input[key] = value;
    }
    parsed.preview = Object.keys(input).length ? input : undefined;
    parsed.previewReady = true;
  }
  return block.status === "preparing" && parsed.preview && Object.keys(parsed.preview).length === 0
    ? undefined
    : parsed.preview;
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
  // The scanner already holds an unfinished escape separately in `escaped`.
  // Never strip a complete trailing \\ pair: doing so makes valid prefixes fail
  // JSON.parse and incorrectly decodes every nested JSON \\n as a real newline.
  const unicodeTail = !closed && /(\\+)u[0-9a-fA-F]{0,3}$/.exec(encoded);
  const normalized =
    unicodeTail && unicodeTail[1].length % 2 === 1
      ? encoded.slice(0, encoded.length - unicodeTail[0].length + unicodeTail[1].length - 1)
      : encoded;
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
