import { expect, it } from "vitest";
import { readReadingBookmark } from "../src/reading-position.ts";

it.each([
  null,
  "not json",
  "null",
  "[]",
  '{"following":"false","top":10}',
  '{"following":false,"top":"10"}',
  '{"following":false,"top":-1}',
])("rejects malformed reading bookmarks: %s", (value) => {
  expect(readReadingBookmark(value)).toBeNull();
});
it("retains legacy pixels and valid anchors without accepting invalid optional fields", () => {
  expect(readReadingBookmark('{"top":12,"following":false,"cursor":0}')).toEqual({
    top: 12,
    following: false,
    cursor: 0,
  });
  expect(readReadingBookmark('{"top":12,"following":false,"cursor":-1,"runId":"a","offset":7}')).toEqual({
    top: 12,
    following: false,
    runId: "a",
    offset: 7,
  });
  expect(readReadingBookmark('{"top":12,"following":false,"runId":"a","offset":"7"}')).toEqual({
    top: 12,
    following: false,
  });
});
