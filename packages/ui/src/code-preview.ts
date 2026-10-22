// ZCode codePreviewSettings / codePreviewPreferences defaults (Apache-2.0).
export const codePreviewThemes = [
  { value: "github-light", label: "GitHub Light" },
  { value: "github-dark", label: "GitHub Dark" },
  { value: "vitesse-light", label: "Vitesse Light" },
  { value: "vitesse-dark", label: "Vitesse Dark" },
  { value: "min-light", label: "Minimal Light" },
  { value: "min-dark", label: "Minimal Dark" },
  { value: "github-light-high-contrast", label: "GitHub HC Light" },
  { value: "github-dark-high-contrast", label: "GitHub HC Dark" },
  { value: "catppuccin-latte", label: "Catppuccin Latte" },
  { value: "catppuccin-mocha", label: "Catppuccin Mocha" },
] as const;
export interface CodePreviewSettings {
  lightTheme: (typeof codePreviewThemes)[number]["value"];
  darkTheme: (typeof codePreviewThemes)[number]["value"];
  fontSizePx: number;
  showLineNumbers: boolean;
  wrapLongLines: boolean;
}
export const defaultCodePreview: CodePreviewSettings = {
  lightTheme: "github-light",
  darkTheme: "github-dark",
  fontSizePx: 12,
  showLineNumbers: true,
  wrapLongLines: false,
};
export function isCodePreviewSettings(value: unknown): value is CodePreviewSettings {
  if (!value || typeof value !== "object") return false;
  const settings = value as CodePreviewSettings;
  return (
    Object.keys(settings).every((key) => Object.hasOwn(defaultCodePreview, key)) &&
    codePreviewThemes.some(({ value }) => value === settings.lightTheme) &&
    codePreviewThemes.some(({ value }) => value === settings.darkTheme) &&
    Number.isInteger(settings.fontSizePx) &&
    settings.fontSizePx >= 12 &&
    settings.fontSizePx <= 20 &&
    typeof settings.showLineNumbers === "boolean" &&
    typeof settings.wrapLongLines === "boolean"
  );
}
