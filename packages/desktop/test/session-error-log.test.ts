import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { chunk, send } from "../../../tests/fake-server.ts";
import { fixture } from "./helpers/host-fixture.ts";

it("records asynchronous provider failures with the session and run IDs", async () => {
  const f = await fixture((_body, response) => {
    response.writeHead(400, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: { message: "Synthetic provider failure" } }));
  });
  const id = f.host.createSession(f.a.id).id;
  const { runId } = await f.host.startRun({ sessionId: id, text: "PRIVATE_USER_MESSAGE" });
  await expect.poll(() => f.host.getSessionSnapshot(id).view.runs.at(-1)?.status).toBe("error");
  const contents = await readFile(join(f.dir, "agent", "logs", "error.log"), "utf8");
  const records = contents
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(records).toContainEqual(expect.objectContaining({ source: "agent.run", sessionId: id, runId }));
  expect(contents).toContain("Synthetic provider failure");
  expect(contents).not.toContain("PRIVATE_USER_MESSAGE");
  expect(contents).not.toContain("secret-host");
  expect(contents).not.toContain("secret-header");
});

it("does not classify a user-aborted task as an exception", async () => {
  const f = await fixture((_body, response) => send(response, chunk({ content: "waiting" })));
  const id = f.host.createSession(f.a.id).id;
  const { runId } = await f.host.startRun({ sessionId: id, text: "wait" });
  await expect.poll(() => f.server.requests.length).toBeGreaterThan(0);
  await f.host.abortRun({ sessionId: id, runId });
  expect(f.host.getSessionSnapshot(id).view.runs.at(-1)?.status).toBe("aborted");
  expect(await readFile(join(f.dir, "agent", "logs", "error.log"), "utf8")).not.toContain("agent.run");
});
