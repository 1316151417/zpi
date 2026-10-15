import { spawn } from "node:child_process";
import { once } from "node:events";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "vitest";

function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test.each(["normal", "failure", "timeout", "cancel", "crash"])(
  "scope guardian cleans owned descendants and resources after %s",
  async (mode) => {
    const root = await mkdtemp(join(tmpdir(), "guardian-"));
    const scope = join(root, "scope");
    const sentinel = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
    const worker = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
    import {spawn} from 'node:child_process';
    import {mkdir,writeFile} from 'node:fs/promises';
    import {once} from 'node:events';
    await mkdir(${JSON.stringify(scope)});
    const guard=spawn(process.execPath,[${JSON.stringify(resolve("tests/helpers/scope-guardian.mjs"))},${JSON.stringify(scope)},String(process.pid)],{stdio:['pipe','pipe','inherit'],detached:true});
    await once(guard.stdout,'data');
    const child=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{stdio:'ignore',detached:true});
    await writeFile(${JSON.stringify(join(root, "child"))},String(child.pid));
    setTimeout(()=>process.stdout.write('ready\\n'),500);
    process.stdin.once('data',()=>guard.stdin.end('close\\n'));
    guard.on('exit',code=>process.exit(code ?? 1));
  `,
      ],
      { stdio: ["pipe", "pipe", "inherit"] },
    );
    const workerExit = once(worker, "exit");
    let pid: number | undefined;
    try {
      await once(worker.stdout, "data");
      pid = Number(await readFile(join(root, "child"), "utf8"));
      expect(alive(pid)).toBe(true);
      if (mode === "normal") worker.stdin.write("close\n");
      else worker.kill(mode === "crash" ? "SIGKILL" : mode === "cancel" ? "SIGINT" : "SIGTERM");
      await workerExit;
      await expect.poll(() => alive(pid as number), { timeout: 8000 }).toBe(false);
      await expect
        .poll(
          async () =>
            access(scope).then(
              () => true,
              () => false,
            ),
          { timeout: 8000 },
        )
        .toBe(false);
      expect(alive(sentinel.pid as number)).toBe(true);
    } finally {
      worker.kill("SIGKILL");
      if (pid && alive(pid)) process.kill(pid, "SIGKILL");
      const exited = once(sentinel, "exit");
      sentinel.kill();
      await exited;
      await rm(root, { recursive: true, force: true });
    }
  },
);
