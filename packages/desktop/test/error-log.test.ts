import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { ResponsesSession } from "zpi-ai/api/responses-session";
import { ErrorLog, maxErrorLogBytes } from "../src/main/error-log.ts";

const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
async function directory() {
  const dir = await mkdtemp(join(tmpdir(), "zpi-error-log-"));
  directories.push(dir);
  return dir;
}

it("appends JSON records beside sessions and preserves earlier errors across restarts", async () => {
  const dir = await directory();
  const log = new ErrorLog(dir, { version: "0.1.17" });
  expect(log.path).toBe(join(dir, "agent", "logs", "error.log"));
  const error = new Error("storage failed\nsecond line");
  log.write("agent.run", error, { sessionId: "session-1", runId: "run-1" });
  new ErrorLog(dir).write("main.startup", "failed again");
  const records = (await readFile(log.path, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(records).toHaveLength(2);
  expect(records[0]).toMatchObject({
    source: "agent.run",
    version: "0.1.17",
    sessionId: "session-1",
    runId: "run-1",
    message: error.message,
    stack: error.stack,
    pid: process.pid,
  });
  expect(Number.isNaN(Date.parse(records[0].time))).toBe(false);
  expect(records[1]).toMatchObject({ source: "main.startup", message: "failed again" });
  if (process.platform !== "win32") expect((await stat(log.path)).mode & 0o777).toBe(0o600);
});

it("redacts common credentials from error messages, stacks and diagnostic context", async () => {
  const log = new ErrorLog(await directory());
  const secrets = [
    "bearer-secret",
    "sk-test123456789",
    "key-secret",
    "access-secret",
    "refresh-secret",
    "oauth-code",
    "eyJabcd.eyJefgh.signature",
  ];
  log.write(
    "provider",
    new Error(
      `Bearer ${secrets[0]} ${secrets[1]} apiKey="${secrets[2]}" access_token=${secrets[3]} refresh_token='${secrets[4]}' ${secrets[6]}`,
    ),
    {
      file: `http://localhost/callback?code=${secrets[5]}&state=state-secret`,
    },
  );
  const contents = await readFile(log.path, "utf8");
  for (const secret of [...secrets, "state-secret"]) expect(contents).not.toContain(secret);
  expect(contents).toContain("[REDACTED]");
  log.write(
    "provider",
    "Authorization: Basic basic-secret; API key provided: provided-secret; token=query-secret",
  );
  const additional = await readFile(log.path, "utf8");
  for (const secret of ["basic-secret", "provided-secret", "query-secret"])
    expect(additional).not.toContain(secret);
  log.write(
    "renderer.console",
    "Loading 'data:font/woff2;base64,BINARY_PAYLOAD' failed at https://user:password-secret@example.com",
  );
  const binary = await readFile(log.path, "utf8");
  expect(binary).not.toContain("BINARY_PAYLOAD");
  expect(binary).not.toContain("password-secret");
  expect(binary).toContain("data:font/woff2;base64,[OMITTED]");
});

it("rotates a full log and retains only the most recent backup", async () => {
  const log = new ErrorLog(await directory());
  await writeFile(log.path, "a".repeat(maxErrorLogBytes));
  log.write("main", "first rollover");
  expect((await stat(`${log.path}.1`)).size).toBe(maxErrorLogBytes);
  expect(JSON.parse(await readFile(log.path, "utf8")).message).toBe("first rollover");
  await writeFile(log.path, "b".repeat(maxErrorLogBytes));
  log.write("main", "second rollover");
  expect((await readFile(`${log.path}.1`, "utf8"))[0]).toBe("b");
  expect(await readdir(dirname(log.path))).toEqual(["error.log", "error.log.1"]);
  log.write("main", "x".repeat(maxErrorLogBytes));
  expect((await stat(log.path)).size).toBeLessThan(maxErrorLogBytes);
});

it("never throws when the log directory cannot be written, and warns once", async () => {
  const dir = await directory();
  const file = join(dir, "not-a-directory");
  await writeFile(file, "existing file");
  const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  const log = new ErrorLog(file);
  expect(() => log.write("main", new Error("original failure"))).not.toThrow();
  log.write("main", "another failure");
  expect(stderr).toHaveBeenCalledTimes(1);
  expect(await readFile(file, "utf8")).toBe("existing file");
});

it("persists all media omission fields and the originating session ID without media data", async () => {
  const log = new ErrorLog(await directory());
  log.mediaProjection(
    {
      omittedMediaCount: 3,
      projectedMediaBytes: 40,
      retainedMediaCount: 2,
      totalMediaBytes: 80,
      evictionFrontier: { messageIndex: 4, blockIndex: 1 },
    },
    { sessionId: "media-session", provider: "fake", modelId: "fake" },
  );
  const record = JSON.parse(await readFile(log.path, "utf8"));
  expect(record).toMatchObject({
    source: "model.media_projection",
    sessionId: "media-session",
    provider: "fake",
    modelId: "fake",
    omittedMediaCount: 3,
    projectedMediaBytes: 40,
    retainedMediaCount: 2,
    totalMediaBytes: 80,
    evictionFrontier: { messageIndex: 4, blockIndex: 1 },
  });
  expect(record).not.toHaveProperty("data");
});

it("persists Responses transport counters and recovery reasons with session context", async () => {
  const log = new ErrorLog(await directory());
  const session = new ResponsesSession();
  log.responsesTransport(
    {
      event: "reconnect",
      transport: "websocket",
      warmup: false,
      reason: "connection_limit",
      stats: { ...session.diagnostics, connectionsCreated: 2, deltaRequests: 3, reconnects: 1 },
    },
    { sessionId: "session", provider: "openai", modelId: "gpt-6.1-terra" },
  );
  session.dispose();
  const record = JSON.parse(await readFile(log.path, "utf8"));
  expect(record).toMatchObject({
    source: "model.responses_transport",
    sessionId: "session",
    provider: "openai",
    modelId: "gpt-6.1-terra",
    event: "reconnect",
    transport: "websocket",
    reason: "connection_limit",
    connectionsCreated: 2,
    deltaRequests: 3,
    reconnects: 1,
  });
  expect(record).not.toHaveProperty("stats");
});
