import { expect, test } from "vitest";
import { findTextMatchRanges } from "../src/renderer/HighlightedMatchText.tsx";

test.each([
  ["İx", "x", [{ start: 1, end: 2 }]],
  ["İx", "i", [{ start: 0, end: 1 }]],
  ["😀İx", "x", [{ start: 3, end: 4 }]],
  ["Review sources", "view review REVIEW", [{ start: 0, end: 6 }]],
  ["abcabc", "ab bc", [{ start: 0, end: 6 }]],
  ["source", " ", []],
])("highlights original text offsets for %s / %s", (text, query, ranges) => {
  expect(findTextMatchRanges(text, query)).toEqual(ranges);
});
