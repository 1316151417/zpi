import type { ITerminalOptions, ITheme } from "@xterm/xterm";
import type { TerminalProfile } from "../shared/bridge.ts";

// ZCode TerminalSession and theme-zai palettes; shell prompts remain untouched.
export const terminalFontFamily =
  "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Monaco, Consolas, 'Cascadia Mono', 'JetBrains Mono', 'MesloLGS NF', 'Hack Nerd Font', 'Noto Sans Mono CJK SC', monospace";

const palettes = {
  light: {
    black: "#5c5c5c",
    red: "#e03131",
    green: "#1e8a3e",
    yellow: "#e07b00",
    blue: "#0b7fff",
    magenta: "#9e77ed",
    cyan: "#0aa7a7",
    white: "#adadad",
    brightBlack: "#888888",
    brightRed: "#e03131",
    brightGreen: "#1e8a3e",
    brightYellow: "#e07b00",
    brightBlue: "#0066dd",
    brightMagenta: "#9e77ed",
    brightCyan: "#0aa7a7",
    brightWhite: "#0d0d0d",
  },
  dark: {
    black: "#363636",
    red: "#ff5c5c",
    green: "#46bf72",
    yellow: "#ff8a30",
    blue: "#4099ff",
    magenta: "#7b5ce5",
    cyan: "#42c8c8",
    white: "#adadad",
    brightBlack: "#747474",
    brightRed: "#ff9999",
    brightGreen: "#87d9a4",
    brightYellow: "#ffb26b",
    brightBlue: "#80beff",
    brightMagenta: "#a888f2",
    brightCyan: "#8ee5e5",
    brightWhite: "#f8f8f8",
  },
} satisfies Record<string, ITheme>;

function fontStack(primary?: string): string {
  if (!primary?.trim()) return terminalFontFamily;
  const families = [...primary.split(","), ...terminalFontFamily.split(",")].map((name) => name.trim());
  const seen = new Set<string>();
  return families
    .filter((name) => {
      const key = name.replace(/^['"]|['"]$/g, "").toLowerCase();
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .join(", ");
}

export function terminalOptions(profile?: TerminalProfile): ITerminalOptions {
  const size = profile?.fontSize;
  return {
    fontFamily: fontStack(profile?.fontFamily),
    fontSize: typeof size === "number" && Number.isFinite(size) && size >= 6 && size <= 72 ? size : 13,
    fontWeight: "normal",
    fontWeightBold: "bold",
    lineHeight: 1,
    letterSpacing: 0,
    cursorBlink: false,
    cursorStyle: "block",
    cursorInactiveStyle: "outline",
    scrollback: 5000,
    allowProposedApi: false,
  };
}

export function terminalTheme(
  dark: boolean,
  background: string,
  foreground: string,
  profile?: TerminalProfile,
): ITheme {
  return {
    ...palettes[dark ? "dark" : "light"],
    selectionBackground: dark ? "rgba(64, 153, 255, 0.28)" : "rgba(11, 127, 255, 0.22)",
    selectionInactiveBackground: dark ? "rgba(255, 255, 255, 0.1)" : "rgba(13, 13, 13, 0.1)",
    ...profile?.theme,
    // Always apply app readability colors last, including after theme changes.
    background: background || (dark ? "#161616" : "#f8f8f8"),
    foreground: foreground || (dark ? "#d4d4d4" : "#262626"),
    cursor: dark ? "#f8f8f8" : "#0d0d0d",
    cursorAccent: dark ? "#161616" : background || "#f8f8f8",
  };
}

export function terminalTitle(cwd: string, usedTitles: readonly string[]): string {
  const base = cwd.split(/[\\/]/).filter(Boolean).at(-1) || "Terminal";
  const used = new Set(usedTitles.map((title) => title.trim()));
  if (!used.has(base)) return base;
  for (let index = 2; ; index++) {
    const title = `${base} ${index}`;
    if (!used.has(title)) return title;
  }
}

// Tailwind colors may be oklch()/color-mix(); xterm only accepts legacy CSS colors.
export function terminalCssColor(style: CSSStyleDeclaration, token: string, fallback: string): string {
  const raw = style.getPropertyValue(token).trim();
  if (!raw) return fallback;
  const probe = document.createElement("span");
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 1;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return fallback;
  try {
    probe.style.color = raw;
    if (!probe.style.color) return fallback;
    document.body.appendChild(probe);
    context.globalCompositeOperation = "copy";
    context.fillStyle = getComputedStyle(probe).color;
    context.fillRect(0, 0, 1, 1);
    const [r, g, b, a = 255] = context.getImageData(0, 0, 1, 1).data;
    return `rgba(${r}, ${g}, ${b}, ${+(a / 255).toFixed(3)})`;
  } catch {
    return fallback;
  } finally {
    probe.remove();
  }
}
