import { ChildProcess, spawn } from "node:child_process";
import * as fs from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { PassThrough } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import { createBashToolDefinition, createLocalBashOperations } from "../src/core/tools/pi/bash.ts";
import { OutputAccumulator } from "../src/core/tools/pi/output-accumulator.ts";
import { DEFAULT_MAX_BYTES } from "../src/core/tools/pi/truncate.ts";
import { waitForChildProcess } from "../src/core/tools/pi/utils/child-process.ts";
import { directory } from "./helpers/session-fixture.ts";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, createWriteStream: vi.fn(actual.createWriteStream) };
});

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});

afterEach(() => vi.restoreAllMocks());

function nodeCommand(script: string): string {
  return `"${process.execPath}" -e '${script}'`;
}

it("pauses both local pipes for a slow spool and preserves the complete output file", async () => {
  const cwd = await directory();
  const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");
  let peakPendingBytes = 0;
  let maxChunkBytes = 0;
  const append = OutputAccumulator.prototype.append;
  vi.spyOn(OutputAccumulator.prototype, "append").mockImplementation(function (
    this: OutputAccumulator,
    data,
  ) {
    maxChunkBytes = Math.max(maxChunkBytes, data.length);
    return append.call(this, data);
  });
  vi.mocked(fs.createWriteStream).mockImplementationOnce((path, options) => {
    const stream = actualFs.createWriteStream(path, options);
    const write = stream._write.bind(stream);
    stream._writev = undefined;
    stream._write = (chunk, encoding, callback) => {
      peakPendingBytes = Math.max(peakPendingBytes, stream.writableLength);
      setTimeout(() => write(chunk, encoding, callback), 5);
    };
    return stream;
  });
  const command = nodeCommand(
    'for (let i = 0; i < 16; i++) { process.stdout.write(Buffer.alloc(65536, 65)); process.stderr.write(Buffer.alloc(65536, 66)); } process.stdout.write("\\nEND\\n");',
  );
  const result = await createBashToolDefinition(cwd).execute("slow-output", { command });
  const path = result.details?.fullOutputPath;
  if (!path) throw new Error("missing full output path");
  try {
    const persisted = await readFile(path, "utf8");
    expect(persisted.length).toBe(2 * 1024 * 1024 + 5);
    expect(persisted.match(/A/g)?.length).toBe(1024 * 1024);
    expect(persisted.match(/B/g)?.length).toBe(1024 * 1024);
    expect(persisted).toContain("\nEND\n");
    expect(peakPendingBytes).toBeLessThanOrEqual(DEFAULT_MAX_BYTES + maxChunkBytes);
    expect(result.structuredContent).toMatchObject({
      truncated: true,
      full_output_path: path,
      exit_code: 0,
    });
    expect(result.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("Full output:") });
  } finally {
    await rm(path, { force: true });
  }
});

it("does not treat paused output after exit as an idle inherited pipe", async () => {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const child = new ChildProcess();
  child.stdout = stdout;
  child.stderr = stderr;
  const chunks: Buffer[] = [];
  stdout.on("data", (chunk) => {
    chunks.push(chunk);
    if (chunks.length === 1) {
      stdout.pause();
      stderr.pause();
    }
  });
  let settled = false;
  const completion = waitForChildProcess(child).then((code) => {
    settled = true;
    return code;
  });
  stdout.write("first");
  stdout.end("last");
  stderr.end();
  child.emit("exit", 0);
  await delay(150);
  expect(settled).toBe(false);
  stdout.resume();
  stderr.resume();
  expect(await completion).toBe(0);
  expect(Buffer.concat(chunks).toString()).toBe("firstlast");
});

it("waits for async output consumers and never invokes stdout and stderr concurrently", async () => {
  const cwd = await directory();
  let pending = 0;
  let peakPending = 0;
  let outputBytes = 0;
  const result = await createLocalBashOperations().exec(
    nodeCommand(
      "for (let i = 0; i < 8; i++) { process.stdout.write(Buffer.alloc(65536)); process.stderr.write(Buffer.alloc(65536)); }",
    ),
    cwd,
    {
      onData: async (chunk) => {
        peakPending = Math.max(peakPending, ++pending);
        await delay(5);
        outputBytes += chunk.length;
        pending--;
      },
    },
  );
  expect(result.exitCode).toBe(0);
  expect(pending).toBe(0);
  expect(peakPending).toBe(1);
  expect(outputBytes).toBe(1024 * 1024);
});

it.each(["abort", "timeout", "reject", "throw"] as const)(
  "settles %s while output is paused and terminates the producer",
  async (mode) => {
    const cwd = await directory();
    const controller = new AbortController();
    let pid: number | undefined;
    const run = createLocalBashOperations().exec(
      nodeCommand(
        'console.log(process.pid); setInterval(() => process.stdout.write("still running\\n"), 5);',
      ),
      cwd,
      {
        signal: controller.signal,
        timeout: mode === "timeout" ? 0.2 : undefined,
        onData: (chunk) => {
          pid ??= Number.parseInt(chunk.toString(), 10);
          if (mode === "abort") setTimeout(() => controller.abort(), 10);
          if (mode === "reject") return Promise.reject(new Error("consumer failed"));
          if (mode === "throw") throw new Error("consumer failed");
          return new Promise<void>(() => {});
        },
      },
    );
    await expect(run).rejects.toThrow(
      mode === "abort" ? "aborted" : mode === "timeout" ? "timeout:0.2" : "consumer failed",
    );
    expect(pid).toBeGreaterThan(0);
    await vi.waitFor(() => {
      const childPid = pid;
      if (!childPid) throw new Error("missing child pid");
      expect(() => process.kill(childPid, 0)).toThrow();
    });
  },
);

it("keeps a queued exit-flush chunk paused behind the latest callback and waits for it", async () => {
  const cwd = await directory();
  const child = new ChildProcess();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  vi.mocked(spawn).mockReturnValueOnce(child);
  const gates = Array.from({ length: 3 }, () => Promise.withResolvers<void>());
  const received: string[] = [];
  let settled = false;
  const run = createLocalBashOperations()
    .exec("test command", cwd, {
      onData: (chunk) => {
        received.push(chunk.toString());
        return gates[received.length - 1].promise;
      },
    })
    .then((result) => {
      settled = true;
      return result;
    });
  await vi.waitFor(() => expect(child.listenerCount("exit")).toBe(1));
  // Node can flush an already-scheduled pipe read even after the consumer paused it.
  child.stdout.emit("data", Buffer.from("first"));
  child.stderr.emit("data", Buffer.from("second"));
  child.stdout.emit("data", Buffer.from("third"));
  expect(received).toEqual(["first"]);
  for (let index = 0; index < 2; index++) {
    gates[index].resolve();
    await vi.waitFor(() => expect(received).toHaveLength(index + 2));
    expect(child.stdout.isPaused()).toBe(true);
    expect(child.stderr.isPaused()).toBe(true);
  }
  child.emit("exit", 0);
  // Reproduce Node's exit-time flush even with no newly readable bytes.
  child.stdout.resume();
  child.stderr.resume();
  await delay(150);
  expect(child.stdout.destroyed).toBe(false);
  expect(child.stderr.destroyed).toBe(false);
  child.emit("close", 0);
  await delay(10);
  expect(settled).toBe(false);
  gates[2].resolve();
  expect(await run).toEqual({ exitCode: 0 });
  expect(received).toEqual(["first", "second", "third"]);
});

it("still releases idle inherited pipes after the shell exits", async () => {
  const child = new ChildProcess();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  const run = waitForChildProcess(child);
  child.emit("exit", 0);
  expect(await run).toBe(0);
  expect(child.stdout.destroyed).toBe(true);
  expect(child.stderr.destroyed).toBe(true);
});

it("preserves synchronous callbacks that return an ignored value", async () => {
  const chunks: Buffer[] = [];
  const result = await createLocalBashOperations().exec(
    nodeCommand('console.log("output")'),
    await directory(),
    {
      onData: (chunk) => chunks.push(chunk),
    },
  );
  expect(result).toEqual({ exitCode: 0 });
  expect(Buffer.concat(chunks).toString()).toBe("output\n");
});
