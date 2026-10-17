import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

// Use a child process so a regression cannot block Vitest's own filesystem worker pool.
it.skipIf(process.platform === "win32")(
  "rejects FIFO reads without retaining filesystem workers after cancellation",
  async () => {
    const cwd = await mkdtemp(join(tmpdir(), "zpi-read-pipes-"));
    directories.push(cwd);
    const pipes = Array.from({ length: 4 }, (_, index) => join(cwd, `pipe-${index}`));
    await promisify(execFile)("mkfifo", pipes);
    const root = resolve(import.meta.dirname, "../../..");
    const modulePath = join(root, "packages/coding-agent/src/core/tools/pi/read.ts");
    const script = `
    import { closeSync, constants, openSync, writeSync } from 'node:fs';
    import { stat } from 'node:fs/promises';
    import { setTimeout as delay } from 'node:timers/promises';
    import { createReadToolDefinition } from ${JSON.stringify(modulePath)};
    const tool = createReadToolDefinition(${JSON.stringify(cwd)});
    const controllers = [], reads = [];
    for (const path of ${JSON.stringify(pipes)}) {
      const controller = new AbortController();
      controllers.push(controller);
      reads.push(tool.execute('fifo', {path}, controller.signal).catch(error => error.message));
      await delay(100);
    }
    controllers.forEach(controller => controller.abort());
    const results = await Promise.all(reads);
    const probe = await Promise.race([stat(${JSON.stringify(cwd)}).then(() => 'ok'), delay(500, 'timed_out')]);
    console.log(JSON.stringify({results, probe}));
    for (const path of ${JSON.stringify(pipes)}) {
      const fd = openSync(path, constants.O_RDWR | constants.O_NONBLOCK);
      writeSync(fd, 'release');
      closeSync(fd);
    }
    await delay(100);
    process.exit(0);
  `;
    const { stdout } = await promisify(execFile)(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", script],
      {
        cwd: root,
        env: { ...process.env, UV_THREADPOOL_SIZE: "4" },
        timeout: 10000,
      },
    ).catch((error) => {
      throw new Error(`${error.message}\nstdout: ${error.stdout}\nstderr: ${error.stderr}`);
    });
    const result = JSON.parse(stdout.trim());
    expect(result.results).toEqual(Array(4).fill("Read requires a regular file"));
    expect(result.probe).toBe("ok");
  },
);
