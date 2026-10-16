import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { TerminalProfile, TerminalProfileTheme } from "../shared/bridge.ts";

type RecordValue = Record<string, unknown>;
const ANSI_KEYS = [
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white",
  "brightBlack",
  "brightRed",
  "brightGreen",
  "brightYellow",
  "brightBlue",
  "brightMagenta",
  "brightCyan",
  "brightWhite",
] as const;

function record(value: unknown): RecordValue | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as RecordValue) : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" ? value.trim() || undefined : undefined;
}

function number(value: unknown): number {
  return typeof value === "number"
    ? value
    : typeof value === "string"
      ? Number.parseFloat(value.trim())
      : Number.NaN;
}

function fontSize(value: unknown): number | undefined {
  const size = number(value);
  return Number.isFinite(size) && size >= 6 && size <= 72 ? size : undefined;
}

function fontDescriptor(value: unknown): Pick<TerminalProfile, "fontFamily" | "fontSize"> {
  const raw = text(value);
  if (raw?.startsWith("YnBsaXN0")) return {};
  return {
    fontFamily:
      raw
        ?.replace(/\s+\d+(?:\.\d+)?$/, "")
        .replaceAll("-", " ")
        .trim() || undefined,
    fontSize: fontSize(raw?.match(/\s+(\d+(?:\.\d+)?)$/)?.[1]),
  };
}

function archivedFont(value: unknown): string | undefined {
  const data = text(record(value)?.NS) ?? text(value);
  if (!data) return undefined;
  const decoded = Buffer.from(data, "base64").toString("latin1");
  if (!decoded.startsWith("bplist")) return undefined;
  const name = decoded.match(
    /([A-Za-z0-9 ._-]*(?:Mono|Code|Nerd|Powerline|Console|Menlo|Monaco|Courier|Cascadia|Consolas|Hack|Meslo)[A-Za-z0-9 ._-]*)/i,
  )?.[1];
  return fontDescriptor(name).fontFamily;
}

function colorComponent(value: unknown): number | undefined {
  const component = number(value);
  if (!Number.isFinite(component) || component < 0 || component > 65_535) return undefined;
  return component <= 1 ? component : component <= 255 ? component / 255 : component / 65_535;
}

function color(value: unknown): string | undefined {
  const raw = text(value);
  if (raw) {
    if (/^#(?:[\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8})$/i.test(raw)) return raw;
    if (/^rgba?\(\s*[\d.%\s,+-]+\)$/i.test(raw)) return raw;
    return undefined;
  }
  const source = record(value);
  if (!source) return undefined;
  const read = (names: string[]) =>
    colorComponent(names.map((name) => source[name]).find((v) => v !== undefined));
  const red = read(["Red Component", "red", "Red"]);
  const green = read(["Green Component", "green", "Green"]);
  const blue = read(["Blue Component", "blue", "Blue"]);
  if (red === undefined || green === undefined || blue === undefined) return undefined;
  const alpha = read(["Alpha Component", "alpha", "Alpha", "Opacity"]) ?? 1;
  const rgb = [red, green, blue].map((component) => Math.round(component * 255));
  if (alpha < 1) return `rgba(${rgb.join(", ")}, ${+alpha.toFixed(3)})`;
  return `#${rgb.map((component) => component.toString(16).padStart(2, "0")).join("")}`;
}

function theme(source: RecordValue, iterm: boolean): TerminalProfileTheme | undefined {
  const result: TerminalProfileTheme = {};
  const selection = color(source[iterm ? "Selection Color" : "SelectionColor"]);
  if (selection) result.selectionBackground = selection;
  for (const [index, key] of ANSI_KEYS.entries()) {
    const terminalKey = `ANSI${key[0].toUpperCase()}${key.slice(1)}Color`;
    const value = iterm
      ? (color(source[`Ansi ${index} Color`]) ?? color(source[`ANSI ${index} Color`]))
      : color(source[terminalKey]);
    if (value) result[key] = value;
  }
  // 基础四色由应用主题统一管理，原生终端仅提供 ANSI 和选区颜色。
  return Object.keys(result).length ? result : undefined;
}

function compact(profile: TerminalProfile): TerminalProfile | undefined {
  return profile.fontFamily || profile.fontSize || profile.theme ? profile : undefined;
}

function itermProfile(plist: RecordValue): TerminalProfile | undefined {
  const profiles = Array.isArray(plist["New Bookmarks"])
    ? plist["New Bookmarks"].map(record).filter((value) => value !== undefined)
    : [];
  const defaultGuid = text(plist["Default Bookmark Guid"]);
  const preferred =
    (defaultGuid ? profiles.find((profile) => profile.Guid === defaultGuid) : undefined) ??
    profiles.find((profile) => profile["Default Bookmark"] === true);
  const ordered = preferred ? [preferred, ...profiles.filter((profile) => profile !== preferred)] : profiles;
  for (const profile of ordered) {
    const detected = compact({ ...fontDescriptor(profile["Normal Font"]), theme: theme(profile, true) });
    if (detected) return detected;
  }
  return undefined;
}

function terminalProfile(plist: RecordValue): TerminalProfile | undefined {
  const settings = record(plist["Window Settings"]);
  for (const key of ["Startup Window Settings", "Default Window Settings"]) {
    const name = text(plist[key]);
    if (!name) continue;
    const profile = record(settings?.[name]) ?? record(plist[name]);
    if (!profile) continue;
    const archived = archivedFont(profile.Font);
    const descriptor = fontDescriptor(profile.Font);
    const detected = compact({
      fontFamily: text(profile.FontName) ?? archived ?? descriptor.fontFamily,
      fontSize: fontSize(profile.FontSize) ?? descriptor.fontSize,
      theme: theme(profile, false),
    });
    if (detected) return detected;
  }
  return undefined;
}

async function readPlist(path: string): Promise<RecordValue | undefined> {
  try {
    await access(path);
    const raw = await new Promise<string>((resolve, reject) => {
      execFile(
        "/usr/bin/plutil",
        ["-convert", "json", "-o", "-", path],
        { encoding: "utf8", shell: false, windowsHide: true, timeout: 2_000, maxBuffer: 2 * 1024 * 1024 },
        (error, stdout) => (error ? reject(error) : resolve(stdout)),
      );
    });
    return record(JSON.parse(raw));
  } catch {
    // 原生配置仅为尽力继承；缺失、格式异常或转换超时均不影响终端创建。
    return undefined;
  }
}

async function detectTerminalProfile(home: string): Promise<TerminalProfile | undefined> {
  const preferences = join(home, "Library", "Preferences");
  const iterm = await readPlist(join(preferences, "com.googlecode.iterm2.plist"));
  const detected = iterm && itermProfile(iterm);
  if (detected) return detected;
  const terminal = await readPlist(join(preferences, "com.apple.Terminal.plist"));
  return terminal && terminalProfile(terminal);
}

const profiles = new Map<string, Promise<TerminalProfile | undefined>>();

export function readTerminalProfile(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): Promise<TerminalProfile | undefined> {
  if (platform !== "darwin" || env.ZPI_TEST_MODE === "1") return Promise.resolve(undefined);
  const home = env.HOME?.trim() || env.USERPROFILE?.trim() || homedir();
  // 每个 HOME 在进程内只检测一次，并发创建共享同一个 Promise，避免重复启动转换进程。
  // 原生终端配置修改在应用重启后生效；缺失配置也缓存，避免每次开标签都重新探测。
  const cached = profiles.get(home);
  if (cached) return cached;
  const profile = detectTerminalProfile(home);
  profiles.set(home, profile);
  return profile;
}
