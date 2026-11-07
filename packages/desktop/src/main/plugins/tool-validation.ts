// Flat collaboration-tool input errors follow ZCode's provider-visible validation format.
import type { Static, TSchema } from "typebox";
import { Value } from "typebox/value";
import { isJsonObject } from "zpi-ai";

export function validateToolArguments(name: string, schema: TSchema, input: unknown) {
  if (Value.Check(schema, input)) return input;
  const definition = schema as TSchema & {
    properties: Record<
      string,
      {
        type: string;
        minLength?: number;
        maxLength?: number;
        minimum?: number;
        maximum?: number;
      }
    >;
    required?: string[];
  };
  const expected = definition.properties;
  const args: Record<string, unknown> = isJsonObject(input) ? input : {};
  const required = definition.required;
  const missing: string[] = [],
    unexpected: string[] = [],
    wrong: string[] = [];
  const issues: unknown[] = [];
  if (!isJsonObject(input))
    wrong.push(
      `The parameter \`\` type is expected as \`object\` but provided as \`${input === null ? "null" : Array.isArray(input) ? "array" : typeof input}\``,
    );
  for (const [key, field] of Object.entries(isJsonObject(input) ? expected : {})) {
    const value = args[key];
    if (value === undefined && !required?.includes(key)) continue;
    if (value === undefined) {
      missing.push(`The required parameter \`${key}\` is missing`);
      continue;
    }
    const received = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
    if (received !== field.type || (typeof value === "number" && !Number.isFinite(value))) {
      wrong.push(
        `The parameter \`${key}\` type is expected as \`${field.type}\` but provided as \`${Number.isNaN(value) ? "NaN" : received}\``,
      );
      continue;
    }
    const size = typeof value === "string" ? value.length : (value as number);
    const lower = field.type === "string" ? field.minLength : field.minimum;
    const upper = field.type === "string" ? field.maxLength : field.maximum;
    const small = lower !== undefined && size < lower;
    if (small || (upper !== undefined && size > upper)) {
      const limit = small ? lower : upper;
      issues.push({
        origin: field.type,
        code: small ? "too_small" : "too_big",
        [small ? "minimum" : "maximum"]: limit,
        inclusive: true,
        path: [key],
        message: `${small ? "Too small" : "Too big"}: expected ${field.type} to ${field.type === "string" ? "have" : "be"} ${small ? ">=" : "<="}${limit}${field.type === "string" ? " characters" : ""}`,
      });
    }
  }
  for (const key of Object.keys(args))
    if (!Object.hasOwn(expected, key)) unexpected.push(`An unexpected parameter \`${key}\` was provided`);
  const lines = [...missing, ...unexpected, ...wrong];
  const body = lines.length
    ? `${name} failed due to the following ${lines.length > 1 ? "issues" : "issue"}:\n${lines.join("\n")}`
    : JSON.stringify(issues, null, 2);
  throw new Error(`<tool_use_error>InputValidationError: ${body}</tool_use_error>`);
}

export function assertToolArguments<T extends TSchema>(
  name: string,
  schema: T,
  input: unknown,
): asserts input is Static<T> {
  validateToolArguments(name, schema, input);
}
