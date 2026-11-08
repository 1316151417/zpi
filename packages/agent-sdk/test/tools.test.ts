import { Check } from "typebox/value";
import { expect, test } from "vitest";
import { Tasks } from "../src/tasks.ts";
import { canonicalTools } from "../src/tools.ts";

test.each([
  { name: "Glob", input: { pattern: "**/*.ts", path: "/missing-sdk-search-path" } },
  {
    name: "Grep",
    input: {
      pattern: "lookup",
      path: "/missing-sdk-search-path",
      glob: "**/*.ts",
      type: "ts",
      output_mode: "content",
      "-i": true,
      "-n": false,
      "-A": 1,
      "-B": 0,
      "-C": 2,
      context: 1,
      multiline: true,
      head_limit: 10,
      offset: 0,
    },
  },
])("$name retains its schema and fails explicitly as an unsupported placeholder", async ({ name, input }) => {
  const tool = canonicalTools(
    "/unused",
    "/unused/tool-output",
    () => {
      throw new Error("Placeholder must not access tool context");
    },
    {},
    new Tasks(),
  ).find((tool) => tool.name === name);
  if (!tool) throw new Error(`Missing ${name} placeholder`);
  expect(tool.label).toBe(name);
  expect(tool.metadata).toEqual({ readOnly: true, concurrentSafe: true });
  expect(Check(tool.parameters, input)).toBe(true);
  expect(Check(tool.parameters, {})).toBe(false);
  if (name === "Grep") {
    expect(Check(tool.parameters, { ...input, output_mode: "invalid" })).toBe(false);
    expect(Check(tool.parameters, { ...input, head_limit: -1 })).toBe(false);
  }
  await expect(
    tool.execute("search", input, new AbortController().signal, undefined, undefined as never),
  ).rejects.toThrow(/^暂不支持$/);
});
