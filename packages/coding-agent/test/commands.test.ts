import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { getCurrentSystemPrompt } from "zpi-ai";
import { chunk, done, send } from "../../../tests/fake-server.ts";
import { fixture } from "./helpers/resource-fixture.ts";

it("init uses the normal read/edit loop and preserves an existing project's instructions", async () => {
  const f = await fixture((_, r, index) => {
    const calls = [
      { name: "read", arguments: { path: "AGENTS.md" } },
      {
        name: "edit",
        arguments: { path: "AGENTS.md", edits: [{ oldText: "old rule", newText: "new rule" }] },
      },
    ];
    if (index < 2) {
      send(
        r,
        chunk({
          tool_calls: [
            {
              index: 0,
              id: `init-${index}`,
              type: "function",
              function: { name: calls[index].name, arguments: JSON.stringify(calls[index].arguments) },
            },
          ],
        }),
      );
      done(r, "tool_calls");
    } else {
      send(r, chunk({ content: "updated" }));
      done(r);
    }
  });
  await writeFile(join(f.cwd, "AGENTS.md"), "Keep this paragraph.\nold rule\n");
  await f.session.submit("/init preserve rules");
  expect(await readFile(join(f.cwd, "AGENTS.md"), "utf8")).toBe("Keep this paragraph.\nnew rule\n");
  expect(JSON.stringify(f.server.requests[0])).toContain("read it first");
  await f.session.prompt("next");
  expect(getCurrentSystemPrompt(f.session.messages)).toContain("new rule");
  expect(getCurrentSystemPrompt(f.session.messages)).not.toContain("old rule");
});
