import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FileIcon } from "../src/components/Reference.tsx";
import names from "../src/file-icon-names.json";
import {
  fallbackFileIconSource,
  fileIconSource,
  INLINE_FALLBACK_FILE_ICON_SRC,
  resolveIconName,
} from "../src/file-icons.ts";
import reference from "./fixtures/file-icons-reference.json";

const assets = new URL("../../desktop/src/renderer/public/material-icons/", import.meta.url);
afterEach(() => vi.unstubAllGlobals());

// Snapshot of both complete alias tables and every SVG from the attributed ZCode revision.
// This fixture stays local: neither the reference checkout nor network access is needed in CI.
describe("ZCode file icon parity", () => {
  it.each(Object.entries(reference.extensions))("maps .%s to %s across case and path styles", (ext, icon) => {
    for (const path of [
      `file.${ext}`,
      `/parent.ts/随便写点.${ext}`,
      `C:\\project\\FILE.${ext.toUpperCase()}`,
    ]) {
      expect(resolveIconName(path)).toBe(icon);
    }
  });

  it.each(Object.entries(reference.fileNames))("preserves the %s filename override", (name, icon) => {
    for (const path of [name, name.toUpperCase(), `/src/${name}.txt`, `C:\\src\\${name}.local.json`]) {
      expect(resolveIconName(path)).toBe(icon);
    }
  });

  it("preserves filename precedence instead of treating README.txt as ordinary text", () => {
    expect(resolveIconName("随便写点.txt")).toBe("document");
    expect(resolveIconName("README.txt")).toBe("readme");
    expect(resolveIconName("README.md")).toBe("readme");
    expect(resolveIconName("cargo.lock")).toBe("lock");
    expect(resolveIconName("cargo.toml")).toBe("rust");
    expect(resolveIconName("vitest.config.ts")).toBe("vitest");
    expect(resolveIconName("tsconfig.base.json")).toBe("tsconfig");
    expect(resolveIconName(".env.local")).toBe("settings");
    expect(resolveIconName("file.test.tsx")).toBe("react_ts");
  });

  it("resolves every direct material extension to a packaged local asset", () => {
    vi.stubGlobal("document", { baseURI: "file:///Applications/ZPI.app/renderer/index.html" });
    for (const name of names) {
      const expected = reference.extensions[name as keyof typeof reference.extensions] ?? name;
      expect(fileIconSource(`file.${name}`)).toBe(
        `file:///Applications/ZPI.app/renderer/material-icons/${expected}.svg`,
      );
    }
  });

  it("keeps unknown names, dotfiles, empty paths and prototype names on document fallback", () => {
    vi.stubGlobal("document", { baseURI: "https://zpi.test/nested/index.html" });
    for (const path of [
      "",
      "LICENSE",
      ".unknown",
      "file.",
      "file.xyz-unknown",
      "constructor",
      "file.constructor",
      "__proto__",
      "file.__proto__",
      "toString",
    ]) {
      expect(fileIconSource(path)).toBe("https://zpi.test/nested/material-icons/document.svg");
    }
    for (const path of ["/src/", "C:\\src\\", "/"]) expect(resolveIconName(path)).toBe("folder");
  });

  it("has the exact complete reference SVG set, unchanged in both themes", () => {
    const files = readdirSync(assets)
      .filter((name) => name.endsWith(".svg"))
      .sort();
    expect(files).toHaveLength(reference.assetCount);
    expect(files.map((file) => file.slice(0, -4)).sort()).toEqual([...names].sort());
    const hash = createHash("sha256");
    for (const file of files)
      hash
        .update(file)
        .update("\0")
        .update(readFileSync(new URL(file, assets)))
        .update("\0");
    expect(hash.digest("hex")).toBe(reference.assetSha256);
    // Reference assets are theme-independent; do not recolor the SVGs in dark mode.
    expect(readFileSync(new URL("document.svg", assets), "utf8")).toContain("#42a5f5");
  });

  it("falls back twice, stops retrying, and resets the image node when its source changes", () => {
    vi.stubGlobal("document", { baseURI: "file:///app/renderer/index.html" });
    const image = FileIcon({ path: "file.ts", size: 14 });
    const target = { src: image.props.src };
    image.props.onError({ currentTarget: target });
    expect(target.src).toBe("file:///app/renderer/material-icons/document.svg");
    image.props.onError({ currentTarget: target });
    expect(target.src).toBe(INLINE_FALLBACK_FILE_ICON_SRC);
    image.props.onError({ currentTarget: target });
    expect(target.src).toBe(INLINE_FALLBACK_FILE_ICON_SRC);
    expect(fallbackFileIconSource(target.src)).toBeNull();
    expect(FileIcon({ path: "file.py" }).key).not.toBe(image.key);
    expect(image.props.width).toBe(14);
    expect(image.props.height).toBe(14);
    expect(image.props["aria-hidden"]).toBe("true");
  });
});
