import type { ChildProcess } from "node:child_process";

export async function stopDesktopProcess(child: ChildProcess | undefined, graceMs = 1500): Promise<void> {
  // Signal exits leave exitCode null; waiting for another exit would hang reload and Ctrl+C.
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (error?: Error) => {
      clearTimeout(timer);
      child.removeListener("exit", exited);
      if (error) reject(error);
      else resolve();
    };
    const exited = () => finish();
    child.once("exit", exited);
    timer = setTimeout(() => {
      timer = setTimeout(() => finish(new Error("Development Electron did not exit")), graceMs);
      try {
        child.kill("SIGKILL");
      } catch (error) {
        finish(error as Error);
      }
    }, graceMs);
    try {
      child.kill("SIGTERM");
    } catch (error) {
      finish(error as Error);
    }
  });
}
