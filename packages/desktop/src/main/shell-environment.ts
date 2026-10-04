import { spawn } from "node:child_process";
import { userInfo } from "node:os";

// Finder launches do not inherit variables exported by shell profiles.
export async function shellEnvironment(base: NodeJS.ProcessEnv = process.env): Promise<NodeJS.ProcessEnv> {
  if (process.platform === "win32") return base;
  const shell = base.SHELL || userInfo().shell || "/bin/sh";
  const start = "__ZPI_ENV_START__\0";
  const end = "__ZPI_ENV_END__\0";
  const command = "printf '__ZPI_ENV_START__\\0'; /usr/bin/env -0; printf '__ZPI_ENV_END__\\0'";
  return new Promise((resolve) => {
    const child = spawn(shell, ["-ilc", command], {
      env: { ...base, TERM: "dumb" },
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    let output = "";
    let bytes = 0;
    let settled = false;
    const finish = (success: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Profiles can leave descendants holding the output pipes open.
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {
        /* The shell may already have exited. */
      }
      child.stdout.destroy();
      child.stderr.destroy();
      const from = output.lastIndexOf(start);
      const to = output.lastIndexOf(end);
      if (!success || from < 0 || to <= from) return resolve(base);
      const captured: NodeJS.ProcessEnv = {};
      for (const entry of output.slice(from + start.length, to).split("\0")) {
        const index = entry.indexOf("=");
        const key = entry.slice(0, index);
        if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && !["_", "SHLVL", "TERM"].includes(key))
          captured[key] = entry.slice(index + 1);
      }
      resolve({ ...captured, ...base, PATH: captured.PATH ?? base.PATH });
    };
    const timer = setTimeout(() => finish(false), 4000);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (data: string) => {
      bytes += Buffer.byteLength(data);
      if (bytes > 2 * 1024 * 1024) finish(false);
      else output += data;
    });
    child.stderr.on("data", (data: Buffer) => {
      bytes += data.length;
      if (bytes > 2 * 1024 * 1024) finish(false);
    });
    child.once("error", () => finish(false));
    child.once("close", (code) => finish(code === 0));
  });
}
