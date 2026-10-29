import type { BundledLanguage, ThemedToken } from "shiki";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toolCodeLanguage, toolPatchLanguage } from "../src/code-language.ts";
import { useToolTokens } from "../src/components/ToolDiff.tsx";

const mocks = vi.hoisted(() => ({
  state: undefined as unknown,
  effect: undefined as undefined | (() => undefined | (() => void)),
  theme: "light",
  highlight: vi.fn(),
  writes: vi.fn(),
}));

vi.mock("react", async () => ({
  ...(await vi.importActual("react")),
  useState: () => [
    mocks.state,
    (value: unknown) => {
      mocks.state = value;
      mocks.writes(value);
    },
  ],
  useEffect: (effect: () => undefined | (() => void)) => {
    mocks.effect = effect;
  },
}));
vi.mock("../src/appearance.ts", () => ({ useAppearance: () => ({ theme: mocks.theme }) }));
vi.mock("shiki", () => ({ codeToTokens: mocks.highlight }));

let cleanup: undefined | (() => void);
function render(code: string, language: BundledLanguage = "typescript", streaming = false) {
  // biome-ignore lint/correctness/useHookAtTopLevel: Hooks are mocked to test asynchronous effect cleanup without a DOM renderer.
  return useToolTokens(code, language, streaming);
}
function commit() {
  cleanup?.();
  cleanup = mocks.effect?.();
}
function tokens(content: string, color = "#123456"): ThemedToken[][] {
  return [[{ content, color, offset: 0 }]];
}
function deferred() {
  let resolve!: (result: { tokens: ThemedToken[][] }) => void;
  const promise = new Promise<{ tokens: ThemedToken[][] }>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

beforeEach(() => {
  mocks.state = undefined;
  mocks.effect = undefined;
  mocks.theme = "light";
  mocks.highlight.mockReset();
  mocks.writes.mockReset();
});
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
  vi.useRealTimers();
});

describe("lightweight diff asynchronous highlighting", () => {
  it("coalesces streaming highlighter work and highlights the latest text after a pause", async () => {
    vi.useFakeTimers();
    mocks.highlight.mockResolvedValue({ tokens: tokens("latest") });
    for (const code of ["first", "second", "latest"]) {
      expect(render(code, "json", true)).toBeUndefined();
      commit();
      await vi.advanceTimersByTimeAsync(50);
    }
    expect(mocks.highlight).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(100);
    await vi.dynamicImportSettled();
    expect(mocks.highlight).toHaveBeenCalledExactlyOnceWith("latest", {
      lang: "json",
      theme: "github-light",
    });
  });

  it("highlights immediately on completion and cancels the pending streaming timer", async () => {
    vi.useFakeTimers();
    mocks.highlight.mockResolvedValue({ tokens: tokens("final") });
    render("partial", "json", true);
    commit();
    await vi.advanceTimersByTimeAsync(50);
    render("final", "json", false);
    commit();
    await vi.dynamicImportSettled();
    expect(mocks.highlight).toHaveBeenCalledExactlyOnceWith("final", {
      lang: "json",
      theme: "github-light",
    });
    await vi.advanceTimersByTimeAsync(200);
    expect(mocks.highlight).toHaveBeenCalledTimes(1);
  });

  it("cancels delayed highlighting when the preview unmounts", async () => {
    vi.useFakeTimers();
    render("partial", "json", true);
    commit();
    cleanup?.();
    await vi.advanceTimersByTimeAsync(200);
    await vi.dynamicImportSettled();
    expect(mocks.highlight).not.toHaveBeenCalled();
  });

  it("keeps the first frame plain and then returns the matching Shiki tokens", async () => {
    const result = tokens("const value = 1;");
    mocks.highlight.mockResolvedValue({ tokens: result });
    expect(render("const value = 1;")).toBeUndefined();
    expect(mocks.highlight).not.toHaveBeenCalled();
    commit();
    await vi.waitFor(() => expect(render("const value = 1;")).toBe(result));
    expect(mocks.highlight).toHaveBeenCalledExactlyOnceWith("const value = 1;", {
      lang: "typescript",
      theme: "github-light",
    });
  });

  it.each(["code", "language", "theme"])("rejects the old result after changing %s", async (change) => {
    const first = deferred(),
      second = deferred();
    mocks.highlight.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    render("initial");
    commit();
    await vi.waitFor(() => expect(mocks.highlight).toHaveBeenCalledTimes(1));
    const nextCode = change === "code" ? "next" : "initial";
    const nextLanguage = change === "language" ? "javascript" : "typescript";
    if (change === "theme") mocks.theme = "dark";
    expect(render(nextCode, nextLanguage)).toBeUndefined();
    commit();
    await vi.waitFor(() => expect(mocks.highlight).toHaveBeenCalledTimes(2));
    const nextTokens = tokens(nextCode, "#654321");
    second.resolve({ tokens: nextTokens });
    await vi.waitFor(() => expect(render(nextCode, nextLanguage)).toBe(nextTokens));
    first.resolve({ tokens: tokens("stale") });
    await first.promise;
    await Promise.resolve();
    expect(render(nextCode, nextLanguage)).toBe(nextTokens);
    expect(mocks.highlight).toHaveBeenLastCalledWith(nextCode, {
      lang: nextLanguage,
      theme: change === "theme" ? "github-dark" : "github-light",
    });
  });

  it.each(["code", "language", "theme"])(
    "hides settled tokens immediately when %s changes",
    async (change) => {
      const result = tokens("initial");
      mocks.highlight.mockResolvedValue({ tokens: result });
      render("initial");
      commit();
      await vi.waitFor(() => expect(render("initial")).toBe(result));
      if (change === "theme") mocks.theme = "dark";
      expect(
        render(change === "code" ? "next" : "initial", change === "language" ? "css" : "typescript"),
      ).toBeUndefined();
    },
  );

  it("does not start tokenization when unmounted before the dynamic import resolves", async () => {
    render("const value = 1;");
    commit();
    cleanup?.();
    await vi.dynamicImportSettled();
    expect(mocks.highlight).not.toHaveBeenCalled();
  });

  it("ignores completed tokenization after unmount", async () => {
    const pending = deferred();
    mocks.highlight.mockReturnValue(pending.promise);
    render("initial");
    commit();
    await vi.waitFor(() => expect(mocks.highlight).toHaveBeenCalledOnce());
    cleanup?.();
    mocks.writes.mockClear();
    pending.resolve({ tokens: tokens("initial") });
    await pending.promise;
    await Promise.resolve();
    expect(mocks.writes).not.toHaveBeenCalled();
  });

  it.each([
    { code: "", language: "typescript" },
    { code: "x".repeat(120_001), language: "typescript" },
    { code: "plain text 2026-10-16 123.45", language: "log" },
  ])("keeps empty, oversized, or plain text inputs unhighlighted ($language)", async ({ code, language }) => {
    expect(render(code, language as BundledLanguage)).toBeUndefined();
    commit();
    await vi.dynamicImportSettled();
    expect(mocks.highlight).not.toHaveBeenCalled();
  });

  it("allows exactly 120,000 characters and keeps fallback text if Shiki rejects", async () => {
    mocks.highlight.mockRejectedValue(new Error("highlighter unavailable"));
    const code = "x".repeat(120_000);
    expect(render(code)).toBeUndefined();
    commit();
    await vi.waitFor(() => expect(mocks.highlight).toHaveBeenCalledOnce());
    await vi.dynamicImportSettled();
    expect(render(code)).toBeUndefined();
  });
});

describe("lightweight diff language inference", () => {
  it.each([
    ["demo.ts", "typescript"],
    ["demo.tsx", "tsx"],
    ["page.html", "html"],
    ["data.json", "json"],
    ["theme.css", "css"],
    ["notes.md", "markdown"],
    ["C:\\work\\SCRIPT.PY", "python"],
    ["notes.txt", "log"],
    ["notes.text", "log"],
    ["events.log", "log"],
    ["unknown.xyz", "log"],
    ["README", "log"],
    ["file.constructor", "log"],
    ["file.__proto__", "log"],
    ["/folder.ts/script", "log"],
    ["/work/icon.svg", "xml"],
    ["/work/chart.mmd", "mermaid"],
    ["/work/chart.mermaid", "mermaid"],
    ["module.mjs", "javascript"],
    ["types.h", "c"],
  ])("infers %s as %s", (path, language) => {
    expect(toolCodeLanguage(path)).toBe(language);
  });

  it("keeps standalone patch inference extension-only with its diff fallback", () => {
    expect(toolPatchLanguage("unknown.xyz")).toBe("diff");
    expect(toolPatchLanguage("README")).toBe("diff");
    expect(toolPatchLanguage("a.txt")).toBe("log");
    expect(toolPatchLanguage("a.TS")).toBe("typescript");
    expect(toolPatchLanguage("a.ts/")).toBe("diff");
    expect(toolCodeLanguage("a.ts/")).toBe("typescript");
  });

  it.each(["file.constructor", "file.__proto__"])("ignores inherited language keys in %s", (path) => {
    expect(toolPatchLanguage(path)).toBe("diff");
  });

  it("uses known extensions before shebang or diff content clues", () => {
    expect(toolCodeLanguage("notes.txt", "#!/usr/bin/python\nprint(123)")).toBe("log");
    expect(toolCodeLanguage("script", "#!/usr/bin/env python\nprint(123)")).toBe("python");
    expect(toolCodeLanguage("script", "#!/bin/sh\necho hi")).toBe("bash");
    expect(toolCodeLanguage("", "#!/bin/bash\necho hi")).toBe("bash");
    expect(toolCodeLanguage("")).toBe("log");
    for (const marker of ["diff --git a/a b/a", "--- a/a", "+++ b/a", "@@ -1 +1 @@"]) {
      expect(toolCodeLanguage("output", `header\n${marker}`)).toBe("diff");
    }
  });

  it("uses languages supported by the installed Shiki highlighter", async () => {
    const { bundledLanguages } = await vi.importActual<typeof import("shiki")>("shiki");
    for (const path of ["a.ts", "a.tsx", "a.py", "a.html", "a.json", "a.md", "a.txt", "a.svg", "a.mmd"]) {
      expect(bundledLanguages[toolCodeLanguage(path)]).toBeDefined();
    }
  });
});
