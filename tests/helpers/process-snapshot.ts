import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execute = promisify(execFile);
export interface ProcessIdentity {
  parent: number;
  born: string;
}
export async function processSnapshot(): Promise<Map<number, ProcessIdentity>> {
  if (process.platform === "win32") {
    const { stdout } = await execute(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CreationDate | ConvertTo-Json -Compress",
      ],
      { windowsHide: true, timeout: 3000 },
    );
    const entries = JSON.parse(stdout) as {
      ProcessId: number;
      ParentProcessId: number;
      CreationDate: string;
    }[];
    return new Map(entries.map((p) => [p.ProcessId, { parent: p.ParentProcessId, born: p.CreationDate }]));
  }
  const { stdout } = await execute("ps", ["-axo", "pid=,ppid=,lstart="], { timeout: 3000 });
  return new Map(
    stdout
      .trim()
      .split("\n")
      .map((line) => {
        const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
        if (!match) throw new Error("Unexpected process snapshot row");
        return [Number(match[1]), { parent: Number(match[2]), born: match[3] }];
      }),
  );
}
export function descendants(owner: number, processes: Map<number, ProcessIdentity>) {
  const found = new Map<number, ProcessIdentity>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const [pid, identity] of processes) {
      if (!found.has(pid) && (identity.parent === owner || found.has(identity.parent))) {
        found.set(pid, identity);
        changed = true;
      }
    }
  }
  return found;
}
