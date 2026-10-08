import { pathToFileURL } from "node:url";
import { describe, expect, test } from "vitest";
import { browserUrl } from "../src/main/browser-url.ts";

describe("browserUrl", () => {
  test("converts absolute filesystem paths to file URLs", () => {
    const path = process.platform === "win32" ? "C:\\a\\b.html" : "/tmp/a/b.html";
    expect(browserUrl(path)).toBe(pathToFileURL(path).href);
  });

  test("converts windows drive paths on any platform spelling", () => {
    expect(browserUrl("C:/a/b.html")).toBe(pathToFileURL("C:/a/b.html").href);
  });

  test("keeps http and https addresses", () => {
    expect(browserUrl("http://127.0.0.1:4111/x")).toBe("http://127.0.0.1:4111/x");
    expect(browserUrl("example.com")).toBe("https://example.com/");
  });

  test("rejects non-http protocols and garbage", () => {
    expect(() => browserUrl("javascript:alert(1)")).toThrow("invalid_input");
    expect(() => browserUrl("ftp://x")).toThrow("invalid_input");
    expect(() => browserUrl("")).toThrow("invalid_input");
  });
});
