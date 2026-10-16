import { bundledLanguages } from "shiki";
import { describe, expect, it } from "vitest";
import { inferPreviewLanguage } from "../src/renderer/preview-language.ts";

describe("reference preview language inference", () => {
  it.each([
    ["note.txt", "log"],
    ["note.text", "log"],
    ["unknown.xyz", "log"],
    ["README", "log"],
    ["C:\\work\\SCRIPT.PY", "python"],
    ["/work/page.svg", "xml"],
    ["/work/graph.mmd", "mermaid"],
    ["/work/graph.mermaid", "mermaid"],
    ["page.md", "markdown"],
    ["module.mjs", "javascript"],
    ["app.tsx", "tsx"],
    ["types.h", "c"],
    ["file.constructor", "log"],
    ["file.__proto__", "log"],
  ])("infers %s as %s", (path, language) => {
    expect(inferPreviewLanguage(path)).toBe(language);
  });
  it("uses extension before content clues", () => {
    expect(inferPreviewLanguage("notes.txt", "#!/usr/bin/python\nprint(1)")).toBe("log");
  });
  it("recognizes shebangs and diff markers for unrecognized paths", () => {
    expect(inferPreviewLanguage("script", "#!/usr/bin/env python\nprint(1)")).toBe("python");
    expect(inferPreviewLanguage(undefined, "#!/bin/bash\necho hi")).toBe("bash");
    expect(inferPreviewLanguage("script", "#!/bin/sh\necho hi")).toBe("bash");
    for (const marker of ["diff --git a/a b/a", "--- a/a", "+++ b/a", "@@ -1 +1 @@"]) {
      expect(inferPreviewLanguage("output", `header\n${marker}`)).toBe("diff");
    }
    expect(inferPreviewLanguage()).toBe("log");
  });
  it("uses languages available in the installed highlighter", () => {
    for (const path of ["a.txt", "a.mmd", "a.svg", "a.py", "a.tsx", "a.diff"]) {
      expect(bundledLanguages[inferPreviewLanguage(path)]).toBeDefined();
    }
  });
});
