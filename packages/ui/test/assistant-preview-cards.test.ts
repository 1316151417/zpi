import { describe, expect, it, vi } from "vitest";
import {
  buildAssistantPreviewCardsFromReferences,
  extractAssistantFileReferences,
  getAssistantPreviewCardFilePath,
  isValidAssistantPreviewWebsiteUrl,
} from "../src/preview/assistant-preview-cards.ts";
import { resolveValidatedAssistantPreviewCards } from "../src/preview/assistant-preview-validation.ts";
import { advancePreviewAutoOpen, createPreviewLoader } from "../src/preview/preview-lifecycle.ts";

const cwd = "/Users/test/project";
const build = (text: string, changedFilePaths: string[] = [], homePath?: string) =>
  buildAssistantPreviewCardsFromReferences(
    text,
    cwd,
    extractAssistantFileReferences(text, cwd, { homePath }),
    { changedFilePaths, homePath },
  );
const paths = (text: string, changes: string[] = [], home?: string) =>
  build(text, changes, home).map(getAssistantPreviewCardFilePath);

describe("ZCode terminal assistant preview candidates", () => {
  it("gates only MD/HTML on this turn's changes, resolving an unambiguous basename", () => {
    expect(paths("report.md page.html old.docx old.xlsx old.pptx old.pdf video.mp4 audio.opus")).toEqual([
      `${cwd}/audio.opus`,
      `${cwd}/video.mp4`,
      `${cwd}/old.pdf`,
      `${cwd}/old.pptx`,
      `${cwd}/old.xlsx`,
      `${cwd}/old.docx`,
    ]);
    expect(paths("report.md page.html", ["out/report.md", "out/page.html"])).toEqual([
      `${cwd}/out/page.html`,
      `${cwd}/out/report.md`,
    ]);
    expect(paths("report.md", ["a/report.md", "b/report.md"])).toEqual([]);
    expect(paths("wrong/report.md", ["out/report.md"])).toEqual([]);
    expect(paths("report.md", [])).toEqual([]);
  });
  it.each([
    ["[报告](<./报告 空格.pdf>)", `${cwd}/报告 空格.pdf`],
    ["`./报告 空格.pdf:12:3`", `${cwd}/报告 空格.pdf`],
    ["“./报告 空格.pdf”", `${cwd}/报告 空格.pdf`],
    ["/Users/test/report.pdf", "/Users/test/report.pdf"],
    ["file:///Users/test/report%20one.pdf", "/Users/test/report one.pdf"],
    ["[encoded](./report%20one.pdf#L2-L5)", `${cwd}/report one.pdf`],
    ["[literal](./report%2520one.pdf)", `${cwd}/report%20one.pdf`],
    ["[Windows](C:\\work\\report.pdf:2)", "C:/work/report.pdf"],
    ["file:///C:/work/report.pdf", "C:/work/report.pdf"],
    ["[home](~/report.pdf)", "/Users/test/report.pdf"],
  ])("resolves %s", (text, expected) => expect(paths(text, [], "/Users/test")).toEqual([expected]));
  it("rejects malformed quotes, unknown home, unsupported directives and external file-looking URLs", () => {
    for (const text of [
      "~/report.pdf",
      "[home](~/report.pdf)",
      "“report.pdf'",
      "[outside](https://example.com/report.pdf)",
      '::zcode-file-citation{path="report.md"}',
      '::zcode-file-citation{path="report.pdf" artifact_kind="presentation"}',
      '::zcode-file-citation{path="report.docx" broken}',
    ])
      expect(build(text, ["report.md"]), text).toEqual([]);
    expect(paths(':::zcode-file-citation{path="报告.docx" artifact_kind="document"}')).toEqual([
      `${cwd}/报告.docx`,
    ]);
    expect(paths(':zcode-file-citation{path="movie.m4v" artifact_kind="video"}')).toEqual([
      `${cwd}/movie.m4v`,
    ]);
  });
  it.each([
    ["http://localhost:3000/path?q=1#part", true],
    ["https://127.0.0.1", true],
    ["http://localhost:0", false],
    ["http://localhost:65536", false],
    ["http://localhost:123456", false],
    ["http://user:pw@localhost:3000", false],
    ["http://localhost.evil.test", false],
    ["https://example.com", false],
    ["http://[::1]:3000", false],
    ["http://127.0.0.1:65535/。", true],
  ])("validates URL %s", (url, valid) => expect(isValidAssistantPreviewWebsiteUrl(url)).toBe(valid));
  it("preserves localhost routes, titles, trailing punctuation, priority, and root URL deduplication", () => {
    const cards = build(
      "page.html [我的网站](http://localhost:3000/app?q=1)。 http://127.0.0.1:4000 http://127.0.0.1:4000/",
      ["page.html"],
    );
    expect(cards).toHaveLength(2);
    expect(cards[1]).toMatchObject({
      type: "website",
      title: "我的网站",
      url: "http://localhost:3000/app?q=1",
    });
    expect(build("http://localhost:3000/page.html", ["page.html"])[0]).toMatchObject({
      filePath: `${cwd}/page.html`,
    });
    expect(build("http://user:pw@localhost:3000 https://example.com")).toEqual([]);
  });
  it("uses the last mention, caps at 15 candidates, stats in one batch and shows at most 10", async () => {
    const text = `${Array.from({ length: 20 }, (_, i) => `file${i}.pdf`).join(" ")} file4.pdf`;
    const candidates = build(text);
    expect(candidates).toHaveLength(15);
    expect(candidates[0].title).toBe("file4.pdf");
    const checkFilesExist = vi.fn(async ({ paths }: { paths: string[] }) =>
      paths.map((path, i) => ({ path, exists: i >= 3 })),
    );
    const visible = await resolveValidatedAssistantPreviewCards(candidates, { checkFilesExist });
    expect(checkFilesExist).toHaveBeenCalledTimes(1);
    expect(visible).toHaveLength(10);
    expect(visible[0].title).toBe("file17.pdf");
    const pure = await resolveValidatedAssistantPreviewCards(build("http://localhost:1"), {
      checkFilesExist,
    });
    expect(pure).toHaveLength(1);
    expect(checkFilesExist).toHaveBeenCalledTimes(1);
  });
  it("all registered media extensions use their actual kind and no changed-file gate", () => {
    for (const ext of ["mp4", "mov", "webm", "m4v", "mp3", "wav", "m4a", "ogg", "opus", "flac", "weba"]) {
      expect(build(`out.${ext}`)[0]).toMatchObject({
        type: "file",
        kind: ["mp4", "mov", "webm", "m4v"].includes(ext) ? "video" : "audio",
      });
    }
    expect(build("image.png text.txt")).toEqual([]);
  });
});

it("coalesces semantic terminal requests and fails closed without guessing changes", async () => {
  const getChangedPaths = vi.fn(async () => {
    throw new Error("unavailable");
  });
  const checkFilesExist = vi.fn(async ({ paths }: { paths: string[] }) =>
    paths.map((path) => ({ path, exists: !path.endsWith("missing.pdf") })),
  );
  const loader = createPreviewLoader({ getChangedPaths, checkFilesExist });
  const input = { sessionId: "a", runId: "r", text: "report.md ok.pdf missing.pdf", cwd };
  const [one, two] = await Promise.all([loader.load(input), loader.load({ ...input })]);
  expect(one).toEqual(two);
  expect(one.map((card) => card.title)).toEqual(["ok.pdf"]);
  expect(getChangedPaths).toHaveBeenCalledTimes(1);
  expect(checkFilesExist).toHaveBeenCalledTimes(1);
  await loader.load({ ...input, sessionId: "b" });
  expect(getChangedPaths).toHaveBeenCalledTimes(2);
});

it("rechecks mutable filesystem existence when a historical turn is mounted again", async () => {
  let exists = true;
  const checkFilesExist = vi.fn(async ({ paths }: { paths: string[] }) =>
    paths.map((path) => ({ path, exists })),
  );
  const loader = createPreviewLoader({ getChangedPaths: async () => [], checkFilesExist });
  const input = { sessionId: "a", runId: "r", text: "ok.pdf", cwd };
  expect(await loader.load(input)).toHaveLength(1);
  exists = false;
  expect(await loader.load(input)).toEqual([]);
  expect(checkFilesExist).toHaveBeenCalledTimes(2);
});

it("arms PPTX only on an observed running edge, clears on session switches and interruption", () => {
  const idle = { scope: "", armed: false };
  expect(advancePreviewAutoOpen(idle, "a", "completed", "r").target).toBeNull();
  const running = advancePreviewAutoOpen(idle, "a", "running", "r").state;
  expect(advancePreviewAutoOpen(running, "a", "completed", "r").target).toBe("a:r");
  expect(advancePreviewAutoOpen(running, "b", "completed", "r").target).toBeNull();
  expect(advancePreviewAutoOpen(running, "a", "aborted", "r").target).toBeNull();
});
