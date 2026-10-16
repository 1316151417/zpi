import { afterEach, expect, it, vi } from "vitest";
import {
  terminalCssColor,
  terminalFontFamily,
  terminalOptions,
  terminalTheme,
  terminalTitle,
} from "../src/renderer/terminal-presentation.ts";

it("uses ZCode terminal typography and stable, non-blinking block cursor defaults", () => {
  expect(terminalOptions()).toMatchObject({
    fontFamily: terminalFontFamily,
    fontSize: 13,
    fontWeight: "normal",
    fontWeightBold: "bold",
    lineHeight: 1,
    letterSpacing: 0,
    cursorBlink: false,
    cursorStyle: "block",
    cursorInactiveStyle: "outline",
  });
});

it("inherits valid native fonts without depending on application UI font size", () => {
  expect(terminalOptions({ fontFamily: "Menlo", fontSize: 15 })).toMatchObject({
    fontFamily: expect.stringMatching(/^Menlo, ui-monospace,/),
    fontSize: 15,
  });
  expect(terminalOptions({ fontFamily: "Menlo" }).fontFamily?.match(/Menlo/g)).toHaveLength(1);
  for (const fontSize of [0, 5, 73, Number.NaN, Number.POSITIVE_INFINITY])
    expect(terminalOptions({ fontSize }).fontSize).toBe(13);
  expect(terminalOptions({ fontSize: 6 }).fontSize).toBe(6);
  expect(terminalOptions({ fontSize: 72 }).fontSize).toBe(72);
});

it("uses complete ZCode ANSI palettes and readable app colors in both appearances", () => {
  const light = terminalTheme(false, "#f8f8f8", "#262626");
  const dark = terminalTheme(true, "#161616", "#d4d4d4");
  expect(light).toMatchObject({
    background: "#f8f8f8",
    foreground: "#262626",
    cursor: "#0d0d0d",
    red: "#e03131",
    brightBlue: "#0066dd",
  });
  expect(dark).toMatchObject({
    background: "#161616",
    foreground: "#d4d4d4",
    cursor: "#f8f8f8",
    red: "#ff5c5c",
    brightBlue: "#80beff",
  });
  expect(Object.keys(light)).toHaveLength(22);
  expect(Object.keys(dark)).toEqual(Object.keys(light));
});

it("preserves inherited ANSI and selection on theme changes without overriding base colors", () => {
  const profile = {
    theme: { red: "#123456", selectionBackground: "#234567", background: "#ffffff", cursor: "#ffffff" },
  };
  for (const dark of [false, true]) {
    const theme = terminalTheme(dark, "#161616", "#d4d4d4", profile);
    expect(theme).toMatchObject({
      background: "#161616",
      foreground: "#d4d4d4",
      red: "#123456",
      selectionBackground: "#234567",
    });
    expect(theme.cursor).toBe(dark ? "#f8f8f8" : "#0d0d0d");
  }
});

it("labels terminal tabs by workspace and uses the next available ordinal", () => {
  expect(terminalTitle("/Users/example/project/", [])).toBe("project");
  expect(terminalTitle("C:\\Users\\example\\project", ["project", "project 3"])).toBe("project 2");
  expect(terminalTitle("/project", ["project", "project 2", " project 3 "])).toBe("project 4");
  expect(terminalTitle("/", [])).toBe("Terminal");
});

afterEach(() => vi.unstubAllGlobals());

it("normalizes modern CSS colors before xterm receives them and removes the probe", () => {
  const probe = { style: { color: "" }, remove: vi.fn() };
  const context = {
    globalCompositeOperation: "",
    fillStyle: "",
    fillRect: vi.fn(),
    getImageData: () => ({ data: [38, 38, 38, 255] }),
  };
  vi.stubGlobal("document", {
    createElement: (tag: string) => (tag === "span" ? probe : { getContext: () => context }),
    body: { appendChild: vi.fn() },
  });
  vi.stubGlobal("getComputedStyle", () => ({ color: "oklch(0.269 0 0)" }));
  const style = { getPropertyValue: () => "oklch(0.269 0 0)" } as unknown as CSSStyleDeclaration;
  expect(terminalCssColor(style, "--color-text", "#262626")).toBe("rgba(38, 38, 38, 1)");
  expect(probe.remove).toHaveBeenCalledOnce();
  expect(context.fillStyle).toBe("oklch(0.269 0 0)");
});

it("keeps readable colors when a CSS token or canvas context is unavailable", () => {
  const empty = { getPropertyValue: () => "" } as unknown as CSSStyleDeclaration;
  expect(terminalCssColor(empty, "--color-text", "#262626")).toBe("#262626");
  vi.stubGlobal("document", { createElement: () => ({ getContext: () => null }) });
  const style = { getPropertyValue: () => "oklch(0.269 0 0)" } as unknown as CSSStyleDeclaration;
  expect(terminalCssColor(style, "--color-text", "#262626")).toBe("#262626");
});
