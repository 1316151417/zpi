import { describe, expect, it } from "vitest";
import {
  markdownHtmlBrowserUrl,
  resolveLinkTarget,
  resolveMarkdownLinkTarget,
  splitFileLocation,
  webOpenTarget,
} from "../src/link-target.ts";

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
  it.each([
    ["/project", "/project/docs/readme.md", "/project"],
    ["C:\\Project", "c:\\project\\docs\\readme.md", "C:/Project"],
    ["\\\\server\\share", "\\\\server\\share\\docs\\readme.md", "//server/share"],
  ])(
    "resolves preview links beside %s documents while retaining workspace bounds",
    (cwd, documentPath, root) => {
      const preview = { cwd, documentPath };
      expect(resolveLinkTarget("images/x.png", preview)).toEqual({
        kind: "file",
        path: `${root}/docs/images/x.png`,
        relative: true,
      });
      expect(resolveLinkTarget("guide.md#L2-L4", preview)).toMatchObject({
        path: `${root}/docs/guide.md`,
        line: 2,
        endLine: 4,
        relative: true,
      });
      expect(resolveLinkTarget("../README.md", preview)).toMatchObject({
        path: `${root}/README.md`,
        relative: true,
      });
      for (const raw of ["../../outside.md", "../%2e%2e/outside.md", "images/../../../outside.png"])
        expect(resolveLinkTarget(raw, preview)).toBeNull();
      expect(resolveLinkTarget("guide.md", { cwd })).toMatchObject({ path: `${root}/guide.md` });
      expect(resolveLinkTarget("../README.md", { cwd })).toBeNull();
    },
  );
  it("keeps preview link bases within the actual workspace and preserves explicit destinations", () => {
    for (const documentPath of ["/other/docs/readme.md", "/project-other/readme.md", "docs/readme.md"])
      expect(resolveLinkTarget("guide.md", { cwd: "/project", documentPath })).toBeNull();
    const preview = { ...context, documentPath: "/workspace/project/docs/readme.md" };
    for (const raw of ["/tmp/report.md", "~/report.md", "https://example.com/guide"])
      expect(resolveLinkTarget(raw, preview)).toEqual(resolveLinkTarget(raw, context));
    expect(resolveLinkTarget("guide.md", { documentPath: "/project/docs/readme.md" })).toBeNull();
  });
  it.each([
    ["/", "/readme.md", "/guide.md"],
    ["C:\\", "C:\\readme.md", "C:/guide.md"],
    ["/project/", "/project/readme.md", "/project/guide.md"],
  ])("handles workspace roots without dropping their separators: %s", (cwd, documentPath, path) => {
    expect(resolveLinkTarget("guide.md", { cwd, documentPath })).toEqual({
      kind: "file",
      path,
      relative: true,
    });
  });
});
describe("file location suffixes", () => {
  it.each([
    ["/tmp/index.ts:284", "/tmp/index.ts", { line: 284 }],
    ["./index.ts:284:3", "./index.ts", { line: 284, column: 3 }],
    ["/tmp/index.ts#L284-L286", "/tmp/index.ts", { line: 284, endLine: 286 }],
    ["C:\\Projects\\index.ts:284:3", "C:\\Projects\\index.ts", { line: 284, column: 3 }],
    ["/tmp/订单 %20 #1.ts:284", "/tmp/订单 %20 #1.ts", { line: 284 }],
    ["/tmp/report.ts%3A284", "/tmp/report.ts%3A284", {}],
  ])("separates location metadata without decoding or rewriting literal paths: %s", (raw, path, location) => {
    expect(splitFileLocation(raw as string)).toEqual({ path, location });
  });
  it.each(["index.ts:0", "index.ts:1:0", "index.ts#L4-L2", "index.ts:9007199254740992"])(
    "rejects invalid locations: %s",
    (raw) => expect(splitFileLocation(raw)).toBeNull(),
  );
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

describe("HTML Markdown webpage intent", () => {
  it.each([
    ["./page.html", "file:///workspace/project/page.html"],
    ["./page.html?time=12:30", "file:///workspace/project/page.html?time=12:30"],
    [
      "./page.html?next=http://localhost:3000",
      "file:///workspace/project/page.html?next=http://localhost:3000",
    ],
    ["./page.html#section:12", "file:///workspace/project/page.html#section:12"],
    ["file:///tmp/page.html?time=12:30", "file:///tmp/page.html?time=12:30"],
    ["./PAGE.HTM?preview=1#intro", "file:///workspace/project/PAGE.HTM?preview=1#intro"],
    ["./%E9%A1%B5%20%2520%2Ehtml?q=1#intro", "file:///workspace/project/%E9%A1%B5%20%2520.html?q=1#intro"],
    ["file:///tmp/page.html?q=1#intro", "file:///tmp/page.html?q=1#intro"],
    ["./name%23part.html#intro", "file:///workspace/project/name%23part.html#intro"],
  ])("preserves browser navigation for %s", (raw, expected) => {
    const target = resolveMarkdownLinkTarget(raw, context);
    expect(target?.kind).toBe("file");
    if (target?.kind !== "file") throw new Error("missing file");
    expect(markdownHtmlBrowserUrl(target.path, target, "markdown-link")).toBe(expected);
    expect(markdownHtmlBrowserUrl(target.path, target)).toBeNull();
  });
  it.each(["./page.html:12:3", "./page.htm#L2-L4", "./page.html?x=1#L2", "file:///tmp/page.html#L4"])(
    "keeps source line references in the file pane: %s",
    (raw) => {
      const target = resolveMarkdownLinkTarget(raw, context);
      expect(target?.kind).toBe("file");
      if (target?.kind !== "file") throw new Error("missing file");
      expect(target.line).toBeGreaterThan(0);
      expect(markdownHtmlBrowserUrl(target.path, target, "markdown-link")).toBeNull();
    },
  );
  it("does not broaden PDF, code, protocol, encoding or path safety rules", () => {
    for (const raw of [
      "../page.html?q=1",
      "./%2e%2e/page.html#intro",
      "./%2Fpage.html?x=1",
      "javascript:page.html?x=1",
      "./bad%zz.html#intro",
      "./page.html#L0",
      "./report.pdf?q=1",
      "./app.ts#intro",
    ])
      expect(resolveMarkdownLinkTarget(raw, context), raw).toBeNull();
    expect(markdownHtmlBrowserUrl("/tmp/report.pdf", undefined, "markdown-link")).toBeNull();
    expect(markdownHtmlBrowserUrl("/tmp/app.ts", undefined, "markdown-link")).toBeNull();
    expect(resolveLinkTarget("./page.html?x=1", context)).toBeNull();
  });
  it("takes the trusted canonical path rather than a supplied file URL path", () => {
    expect(
      markdownHtmlBrowserUrl(
        "/safe/page.html",
        { fileUrl: "file:///other/page.html?q=1#intro" },
        "markdown-link",
      ),
    ).toBe("file:///safe/page.html?q=1#intro");
  });
});
