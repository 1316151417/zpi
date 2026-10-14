import { expect, test } from "vitest";
import { chunk, done, send } from "../../../tests/fake-server.ts";
import { fixture, run } from "./helpers/context-fixture.ts";

test("a deferred per-tool patch is addressed by its operation key, not its raw tool call ID", async () => {
  const f = await fixture((_body, response, index) => {
    if (index === 0) {
      send(
        response,
        chunk({
          tool_calls: [
            {
              index: 0,
              id: "large-write",
              type: "function",
              function: {
                name: "write",
                arguments: JSON.stringify({ path: "large.txt", content: "new line\n".repeat(10000) }),
              },
            },
          ],
        }),
      );
      done(response, "tool_calls");
    } else {
      send(response, chunk({ content: "done" }));
      done(response);
    }
  });
  await run(f, "write a large patch");
  const view = f.host.getSessionSnapshot(f.session.id).view;
  const turn = view.runs[0];
  const tool = turn.orderedBlocks.find((block) => block.type === "tool");
  expect(tool).toMatchObject({ fileChange: { patchAvailable: true } });
  await expect(f.host.readPatch(f.session.id, turn.runId, "large-write")).rejects.toThrow("not_found");
  const patch = await f.host.readPatch(f.session.id, turn.runId, "operation:large-write");
  expect(patch).toContain("+new line");
  expect(Buffer.byteLength(patch)).toBeGreaterThan(64 * 1024);
});
