// Adapted from Pi c20cb09772bf4e2590a316cb54514cef76df4293.
// Copyright (c) 2025 Mario Zechner. MIT license: THIRD_PARTY_NOTICES.md.

import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

const getBinDir = () => join(homedir(), ".ZPI", "agent", "bin");

export interface ShellConfig {
  shell: string;
  args: string[];
  commandTransport?: "argv" | "stdin";
}

/**
 * Find bash executable on PATH (cross-platform)
 */
function isLegacyWslBashPath(path: string): boolean {
  const normalized = path.replace(/\//g, "\\").toLowerCase();
  return /^[a-z]:\\windows\\(?:system32|sysnative)\\bash\.exe$/.test(normalized);
}

function getBashShellConfig(shell: string): ShellConfig {
  return isLegacyWslBashPath(shell)
    ? { shell, args: ["-s"], commandTransport: "stdin" }
    : { shell, args: ["-c"] };
}

/**
 * Spawned WSL launchers and WindowsApps aliases block forever when the backing
 * app is missing or broken (no error, no output). Before committing to one as
 * the session shell, probe it once with a hard deadline so a broken setup fails
 * with guidance instead of hanging every command.
 */
const launcherBashProbes = new Map<string, boolean>();
function isLauncherBashPath(path: string): boolean {
  return isLegacyWslBashPath(path) || path.includes("\\WindowsApps\\");
}
function isLauncherBashUsable(shell: string): boolean {
  let usable = launcherBashProbes.get(shell);
  if (usable === undefined) {
    try {
      usable =
        spawnSync(shell, ["-c", "echo ok"], {
          encoding: "utf-8",
          timeout: 4000,
          windowsHide: true,
        }).status === 0;
    } catch {
      usable = false;
    }
    launcherBashProbes.set(shell, usable);
  }
  return usable;
}

/** Bash.exe next to a git.exe installation, whatever the install directory. */
function findGitBash(): string | null {
  try {
    const result = spawnSync("where", ["git.exe"], {
      encoding: "utf-8",
      timeout: 5000,
      windowsHide: true,
    });
    if (result.status !== 0 || !result.stdout) return null;
    for (const entry of result.stdout.trim().split(/\r?\n/)) {
      // Git for Windows layouts: <root>\cmd\git.exe, <root>\bin\git.exe or <root>\mingw64\bin\git.exe.
      const git = entry.trim();
      const root = git.replace(/[\\/](?:cmd|bin|mingw64[\\/]bin)[\\/]git\.exe$/i, "");
      if (root === git) continue;
      const bash = `${root}\\bin\\bash.exe`;
      if (existsSync(bash)) return bash;
    }
  } catch {
    // Ignore errors
  }
  return null;
}

/**
 * All bash.exe entries on PATH. The System32 WSL launcher and the WindowsApps
 * execution alias both exist on nearly every machine while real Git installs
 * live elsewhere, so callers must rank matches themselves.
 */
function findBashEntriesOnPath(): string[] {
  try {
    const result = spawnSync("where", ["bash.exe"], {
      encoding: "utf-8",
      timeout: 5000,
      windowsHide: true,
    });
    if (result.status === 0 && result.stdout) {
      return result.stdout
        .trim()
        .split(/\r?\n/)
        .map((entry) => entry.trim())
        .filter((entry) => entry && existsSync(entry));
    }
  } catch {
    // Ignore errors
  }
  return [];
}

/** Unix: use 'which' and trust its output (handles Termux and special filesystems). */
function findUnixExecutableOnPath(executable: string): string | null {
  try {
    const result = spawnSync("which", [executable], { encoding: "utf-8", timeout: 5000 });
    if (result.status === 0 && result.stdout) {
      const firstMatch = result.stdout.trim().split(/\r?\n/)[0];
      if (firstMatch) {
        return firstMatch;
      }
    }
  } catch {
    // Ignore errors
  }
  return null;
}

/**
 * Resolve shell configuration based on platform and an optional explicit shell path.
 * Resolution order:
 * 1. User-specified shellPath
 * 2. On Windows: Git Bash in known locations, then bash on PATH
 * 3. On Unix: /bin/bash, then bash on PATH, then fallback to sh
 */
export function getShellConfig(customShellPath?: string): ShellConfig {
  // 1. Check user-specified shell path
  if (customShellPath) {
    if (existsSync(customShellPath)) {
      return getBashShellConfig(customShellPath);
    }
    throw new Error(`Custom shell path not found: ${customShellPath}`);
  }

  if (process.platform === "win32") {
    // 2. Try Git Bash in known locations
    const paths: string[] = [];
    const programFiles = process.env.ProgramFiles;
    if (programFiles) {
      paths.push(`${programFiles}\\Git\\bin\\bash.exe`);
    }
    const programFilesX86 = process.env["ProgramFiles(x86)"];
    if (programFilesX86) {
      paths.push(`${programFilesX86}\\Git\\bin\\bash.exe`);
    }

    for (const path of paths) {
      if (existsSync(path)) {
        return getBashShellConfig(path);
      }
    }

    // 3. Derive bash from the git.exe installation for custom install directories.
    const gitBash = findGitBash();
    if (gitBash) {
      return getBashShellConfig(gitBash);
    }

    // 4. Fallback: bash.exe on PATH, preferring a real bash over WSL launchers.
    const entries = findBashEntriesOnPath();
    const bashOnPath =
      entries.find((entry) => !isLauncherBashPath(entry)) ??
      entries.find((entry) => isLauncherBashUsable(entry));
    if (bashOnPath) {
      return getBashShellConfig(bashOnPath);
    }

    throw new Error(
      `No bash shell found. Options:\n` +
        `  1. Install Git for Windows: https://git-scm.com/download/win\n` +
        `  2. Add your bash to PATH (Cygwin, MSYS2, etc.)\n` +
        "  3. Set shellPath in settings.json\n\n" +
        `Searched Git Bash in:\n${paths.map((p) => `  ${p}`).join("\n")}`,
    );
  }

  // Unix: try /bin/bash, then bash on PATH, then fallback to sh
  if (existsSync("/bin/bash")) {
    return getBashShellConfig("/bin/bash");
  }

  const bashOnPath = findUnixExecutableOnPath("bash");
  if (bashOnPath) {
    return getBashShellConfig(bashOnPath);
  }

  return { shell: "sh", args: ["-c"] };
}

export function getShellEnv(): NodeJS.ProcessEnv {
  const binDir = getBinDir();
  const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === "path") ?? "PATH";
  const currentPath = process.env[pathKey] ?? "";
  const pathEntries = currentPath.split(delimiter).filter(Boolean);
  const hasBinDir = pathEntries.includes(binDir);
  const updatedPath = hasBinDir ? currentPath : [binDir, currentPath].filter(Boolean).join(delimiter);

  return {
    ...process.env,
    [pathKey]: updatedPath,
  };
}

/**
 * Kill a process and all its children (cross-platform)
 */
export function killProcessTree(pid: number): void {
  if (process.platform === "win32") {
    // Use the trusted System32 executable so cleanup does not depend on PATH.
    try {
      const child = spawn(
        join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"),
        ["/F", "/T", "/PID", String(pid)],
        {
          stdio: "ignore",
          detached: true,
          windowsHide: true,
        },
      );
      // A failed spawn emits "error" asynchronously; consume it to avoid crashing Node.
      child.once("error", () => {});
    } catch {
      // Ignore errors if taskkill fails.
    }
  } else {
    // Use SIGKILL on Unix/Linux/Mac
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // Fallback to killing just the child if process group kill fails
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Process already dead
      }
    }
  }
}
