import { describe, expect, it } from "vitest";
import { resolveLinkTarget, webOpenTarget } from "../src/link-target.ts";

const context = { cwd: "/workspace/project", home: "/Users/test" };
describe("Markdown link targets", () => {
  it("separates HTTP pages from local files, preserving web queries and fragments", () => {
    expect(resolveLinkTarget("file:///tmp/page.html?preview=1#start", context)).toMatchObject({
      kind: "file",
      path: "/tmp/page.html",
      fileUrl: "file:///tmp/page.html?preview=1#start",
    });
    expect(resolveLinkTarget("https://example.com/page.html?x=1#L4", context)).toEqual({
      kind: "web",
      url: "https://example.com/page.html?x=1#L4",
    });
    expect(resolveLinkTarget("./page.html", context)).toEqual({
      kind: "file",
      path: "/workspace/project/page.html",
      relative: true,
    });
  });
  it("normalizes relative, Unix, Windows, UNC and home paths without duplicating cwd", () => {
    for (const raw of ["./src/app.ts", "src/app.ts", "./src/../src/app.ts"])
      expect(resolveLinkTarget(raw, context)).toMatchObject({
        path: "/workspace/project/src/app.ts",
        relative: true,
      });
    expect(resolveLinkTarget("README.md", context)).toMatchObject({ path: "/workspace/project/README.md" });
    expect(resolveLinkTarget("/opt/code/app.ts", context)).toMatchObject({ path: "/opt/code/app.ts" });
    expect(resolveLinkTarget("C:\\Users\\test\\.config\\a.json", context)).toMatchObject({
      path: "C:/Users/test/.config/a.json",
    });
    expect(resolveLinkTarget("file:///C:/Users/test/a.json", context)).toMatchObject({
      path: "C:/Users/test/a.json",
    });
    expect(resolveLinkTarget("file://server/share/a.json", context)).toMatchObject({
      path: "//server/share/a.json",
    });
    expect(resolveLinkTarget("~/Documents/report.pdf", context)).toMatchObject({
      path: "/Users/test/Documents/report.pdf",
    });
  });
  it("decodes spaces, Chinese and literal percent names exactly once; propagates locations", () => {
    expect(resolveLinkTarget("file:///tmp/%E8%AE%A2%E5%8D%95%20%2520.json:12:3", context)).toMatchObject({
      path: "/tmp/订单 %20.json",
      line: 12,
      column: 3,
    });
    expect(resolveLinkTarget("./report%23one%3F.json#L2-L4", context)).toMatchObject({
      path: "/workspace/project/report#one?.json",
      line: 2,
      endLine: 4,
    });
    expect(resolveLinkTarget("“/tmp/订单 汇总.json”", context)).toMatchObject({
      path: "/tmp/订单 汇总.json",
    });
  });
  it("rejects unsupported protocols, malformed escapes and relative traversal", () => {
    for (const raw of [
      "javascript:alert(1)",
      "%6aavascript:alert.txt",
      "mailto:a@b.com",
      "data:text/html,test",
      "ftp://example.com/a.txt",
      "#section",
      "../outside.txt",
      "./src/../../outside.txt",
      "./%2e%2e/outside.txt",
      "./%2Fetc/passwd",
      "./bad%zz.txt",
      "./a%00.txt",
      "~/../file.txt",
      "~other/file.txt",
      "README.md:0",
      "README.md#L4-L2",
      "README.md:9007199254740992",
      "https://user:pass@example.com/",
    ])
      expect(resolveLinkTarget(raw, context), raw).toBeNull();
    expect(resolveLinkTarget("README.md")).toBeNull();
    expect(resolveLinkTarget("~/file.txt")).toBeNull();
    expect(resolveLinkTarget("~/file.txt", { home: "relative" })).toBeNull();
  });
});
describe("web open routing", () => {
  it("uses the embedded browser for ZCode's local and private development hosts", () => {
    for (const host of [
      "localhost",
      "localhost.localdomain",
      "app.localhost",
      "machine.local",
      "app.test",
      "127.0.0.2",
      "0.0.0.0",
      "10.1.2.3",
      "172.16.0.1",
      "172.31.0.1",
      "192.168.1.2",
      "169.254.0.2",
      "[::1]",
    ])
      expect(webOpenTarget(`http://${host}:8080/page`), host).toBe("app-browser");
    for (const host of ["example.com", "172.15.0.1", "172.32.0.1", "localhost.example.com"])
      expect(webOpenTarget(`https://${host}`)).toBe("external-browser");
  });
  it("honors explicit targets and lets Cmd/Ctrl override embedded mode", () => {
    expect(webOpenTarget("http://localhost", { forceExternal: true })).toBe("external-browser");
    expect(webOpenTarget("https://example.com", { forceInApp: true })).toBe("app-browser");
    expect(webOpenTarget("https://example.com", { forceInApp: true, forceExternal: true })).toBe(
      "external-browser",
    );
  });
});
