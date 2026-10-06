import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { getCurrentSystemPrompt } from "zpi-ai";
import { chunk, done, send } from "../../../tests/fake-server.ts";
import { parseInput } from "../src/index.ts";
import { fixture } from "./helpers/resource-fixture.ts";

it.each([
  "/中文读杠",
  "/",
  "/tmp/project 请检查这个目录",
  "/compact-extra",
  "/init.md",
  "/init/path",
  "/unknown task\nmore details",
  "  /中文输入\n保留空白  ",
  "$100",
  "$100 is the price",
  "$unknown task",
  "$中文",
  "$HOME/path",
  "@hello",
  "@someone@example.com",
  "@/tmp/missing",
])("preserves slash-prefixed text as a prompt: %j", (text) => {
  expect(parseInput(text)).toEqual({ kind: "prompt", text });
});

it("routes a plain skill name only when it is available", () => {
  expect(parseInput("$review check", ["review"])).toEqual({ kind: "skill", name: "review", task: "check" });
  expect(parseInput("$review check", ["other"])).toEqual({ kind: "prompt", text: "$review check" });
});

it.each(["init", "compact"] as const)("recognizes only the exact /%s command", (name) => {
  expect(parseInput(`/${name}`)).toEqual({ kind: name, args: "" });
  expect(parseInput(`  /${name}\t first line\nsecond line  `)).toEqual({
    kind: name,
    args: "first line\nsecond line",
  });
});

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
