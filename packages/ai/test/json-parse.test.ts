import { expect, it } from "vitest";
import { parseJsonWithRepair } from "../src/utils/json-parse.ts";

it.each([
  [String.raw`{"path":"C:\user\x"}`, String.raw`C:\user\x`],
  [String.raw`{"path":"\u12z4"}`, String.raw`\u12z4`],
  [String.raw`{"path":"\u4e2d"}`, "中"],
])("repairs invalid unicode escapes while preserving valid ones in %s", (json, expected) => {
  expect(parseJsonWithRepair(json)).toEqual({ path: expected });
});
