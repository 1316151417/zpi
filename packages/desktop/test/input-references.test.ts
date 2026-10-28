import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { parseMentions } from "zpi-coding-agent/input";
import { chunk, done, send } from "../../../tests/fake-server.ts";
import { fixture } from "./helpers/host-fixture.ts";

it.each([false, true])(
  "submits missing file references without losing context (absolute: %s)",
  async (absolute) => {
    const f = await fixture((_, response) => {
      send(response, chunk({ content: "ok" }));
      done(response);
    });
    const session = await f.host.createSession(f.a.id);
    await writeFile(join(f.a.path, "existing.ts"), "export {};\n");
    const path = absolute ? join(f.a.path, "missing.ts") : "./missing.ts";
    const fileReferences = ["./existing.ts", path, `${path}:422:3`, `${path}#L422-L428`, `${path}/folder/`];
    const text = `Review [missing.ts:422–428](<${path}#L422-L428>)`;
    await expect(f.host.submitInput({ sessionId: session.id, text, fileReferences })).resolves.toHaveProperty(
      "runId",
    );
    await f.host.activeRuns.get(session.id)?.done;
    expect(f.host.getSessionSnapshot(session.id).view.runs[0]).toMatchObject({
      userMessage: text,
      fileReferences,
      status: "completed",
    });
    const messages = f.server.requests[0].messages as { role: string; content: string }[];
    const prompt = messages.findLast((message) => message.role === "user")?.content;
    expect(prompt).toContain(text);
    for (const reference of ["./existing.ts", path, join(f.a.path, "missing.ts"), `${path}/folder/`])
      expect(prompt).toContain(`- ${JSON.stringify(reference)}`);
  },
);

it.each(["../missing.ts", "../missing.ts:422", "../missing.ts#L422-L428", "missing\0.ts"])(
  "still rejects invalid or out-of-workspace references: %j",
  async (reference) => {
    const f = await fixture((_, response) => done(response));
    const session = await f.host.createSession(f.a.id);
    await expect(
      f.host.submitInput({ sessionId: session.id, text: "review", fileReferences: [reference] }),
    ).rejects.toThrow(/invalid_input/);
    expect(f.server.requests).toHaveLength(0);
  },
);

it("submits Markdown code examples without treating sample links as required file attachments", async () => {
  const f = await fixture((_, response) => {
    send(response, chunk({ content: "explanation" }));
    done(response);
  });
  const session = await f.host.createSession(f.a.id);
  const text = "Explain this Markdown example:\n```markdown\n[API](./nonexistent-example.md)\n```";
  const fileReferences = parseMentions(text)
    .filter((mention) => mention.kind === "file")
    .map((mention) => mention.path);
  await expect(f.host.submitInput({ sessionId: session.id, text, fileReferences })).resolves.toHaveProperty(
    "runId",
  );
  await f.host.activeRuns.get(session.id)?.done;
  expect(f.host.getSessionSnapshot(session.id).view.runs[0].userMessage).toBe(text);
});
