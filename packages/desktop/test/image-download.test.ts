import { expect, it } from "vitest";
import { downloadableImageUrl } from "../src/main/file-preview.ts";

it.each(["png", "jpeg", "gif", "webp", "bmp", "avif", "apng", "x-icon", "svg+xml"])(
  "accepts the preview MIME image/%s for downloads",
  (mime) => {
    expect(downloadableImageUrl(`data:image/${mime};base64,AA==`)).toBe(true);
  },
);
it.each([
  "file:///etc/hosts",
  "javascript:alert(1)",
  "data:text/html;base64,AA==",
  "data:image/svg+xml,encoded",
  "https://",
  "http:",
])("rejects unsupported download input %s", (url) => {
  expect(downloadableImageUrl(url)).toBe(false);
});
