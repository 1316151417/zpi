import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { fixture, run } from "./helpers/context-fixture.ts";

it("writes one persistent media projection event for a real desktop session request", async () => {
  const f = await fixture();
  // biome-ignore lint/complexity/useLiteralKeys: Seed canonical history through the test fixture's private manager.
  const manager = f.host["manager"](f.session.id);
  const image = { type: "image" as const, mimeType: "image/png", data: "a".repeat(6 * 1024 * 1024) };
  for (let i = 0; i < 7; i++)
    await manager.appendMessageAsync({ role: "user", content: [image], timestamp: i });
  await run(f, "inspect the current history");
  expect(f.server.requests).toHaveLength(1);
  const records = (await readFile(join(f.dir, "agent", "logs", "error.log"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const projections = records.filter((record) => record.source === "model.media_projection");
  expect(projections).toHaveLength(1);
  expect(projections[0]).toMatchObject({
    sessionId: f.session.id,
    omittedMediaCount: 1,
    retainedMediaCount: 6,
    totalMediaBytes: 7 * (image.data.length + 22),
    projectedMediaBytes: 6 * (image.data.length + 22),
    evictionFrontier: { messageIndex: expect.any(Number), blockIndex: 0 },
  });
  expect(JSON.stringify(projections)).not.toContain(image.data);
}, 30_000);
