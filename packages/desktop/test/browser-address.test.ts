import { describe, expect, it } from "vitest";
import { browserAddressAfterNavigation } from "../src/renderer/browser-address.ts";

describe("browser address synchronization", () => {
  it("canonicalizes submitted domains and local paths", () => {
    expect(browserAddressAfterNavigation("example.test", "https://example.test/", "example.test")).toBe(
      "https://example.test/",
    );
    expect(
      browserAddressAfterNavigation("/tmp/preview.html", "file:///tmp/preview.html", "/tmp/preview.html"),
    ).toBe("file:///tmp/preview.html");
  });
  it("preserves a new draft typed while a submitted navigation is loading", () => {
    expect(browserAddressAfterNavigation("new draft", "https://example.test/", "example.test")).toBe(
      "new draft",
    );
  });
  it("preserves focused unsent edits when the page redirects", () => {
    expect(browserAddressAfterNavigation("new draft", "https://example.test/redirect", null, true)).toBe(
      "new draft",
    );
  });
  it("updates an idle address after back, forward, reload or redirect", () => {
    expect(browserAddressAfterNavigation("https://example.test/", "https://example.test/next", null)).toBe(
      "https://example.test/next",
    );
  });
});
