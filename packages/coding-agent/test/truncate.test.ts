import { expect, it } from "vitest";
import { truncateHead, truncateTail } from "../src/core/tools/pi/truncate.ts";

it("truncation reports the limiting cap, including a partial tail with a one-line cap", () => {
  expect(truncateTail("header\nlong-last-line", { maxLines: 1, maxBytes: 4 })).toMatchObject({
    content: "line",
    truncatedBy: "bytes",
    lastLinePartial: true,
    outputLines: 1,
  });
  for (const truncate of [truncateHead, truncateTail]) {
    expect(truncate("a\nb\nc", { maxLines: 1, maxBytes: 10 }).truncatedBy).toBe("lines");
    expect(truncate("a\nb\nc", { maxLines: 3, maxBytes: 1 }).truncatedBy).toBe("bytes");
    expect(truncate("a\nb\nc", { maxLines: 2, maxBytes: 3 }).truncatedBy).toBe("lines");
  }
});
