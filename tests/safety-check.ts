import { readdir, readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

export function sourceViolations(path: string, source: string): string[] {
  const errors: string[] = [];
  const check = (pattern: RegExp, message: string) => {
    if (pattern.test(source)) errors.push(`${path}: ${message}`);
  };
  if (
    (path.startsWith("packages/desktop/src/main/") ||
      path.startsWith("scripts/") ||
      path.startsWith("tests/")) &&
    !path.endsWith("/automation.ts") &&
    path !== "tests/safety-check.ts"
  )
    check(/new\s+(?:BrowserWindow|BaseWindow)\s*\(/, "create windows through createDesktopWindow");
  if (path.startsWith("tests/desktop/") || path.startsWith("tests/interactive/"))
    check(
      /import\s*\{[^}]*\btest\b[^}]*\}\s*from\s*["']@playwright\/test["']/,
      "use the automatic cleanup fixture from helpers/test.ts",
    );
  if (path.startsWith("tests/") || path.startsWith("scripts/")) {
    if (!["tests/helpers/desktop.ts", "tests/safety-check.ts"].includes(path))
      check(
        /import[^;]*\b_electron\b|\b(?:electron|chromium|firefox|webkit)\s*\.\s*launch(?:PersistentContext)?\s*\(/,
        "use the shared Electron launcher",
      );
    if (path !== "tests/safety-check.ts") {
      check(
        /\b(?:osascript|xdotool|ydotool|robotjs|nut-js|pbcopy|pbpaste|cliclick)\b/,
        "OS input/clipboard automation is not allowed; use page events",
      );
      check(/\+[cCvVxX]["'`]/, "use synthetic ClipboardEvent instead of native clipboard shortcuts");
      check(/\bbringToFront\s*\(/, "native window activation requires interactive coverage");
    }
  }
  if (/packages\/[^/]+\/test\//.test(path)) {
    check(
      /^\s*import\s+(?!type\b)[^;\n]*from\s*["'](?:electron|@playwright\/test)["']/m,
      "unit tests must not import a GUI launcher at runtime",
    );
  }
  return errors;
}

export default async function safetyCheck() {
  const root = resolve(import.meta.dirname, "..");
  const errors: string[] = [];
  async function visit(directory: string) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (["node_modules", "dist", "public", "assets"].includes(entry.name)) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (/\.(?:[cm]?[jt]sx?)$/.test(entry.name))
        errors.push(
          ...sourceViolations(relative(root, path).replaceAll("\\", "/"), await readFile(path, "utf8")),
        );
    }
  }
  for (const dir of ["tests", "scripts", "packages"]) await visit(join(root, dir));
  if (errors.length) throw new Error(`Unsafe automation entry points:\n${errors.join("\n")}`);
}
if (process.argv[1] === import.meta.filename) await safetyCheck();
