import { expect, it } from "vitest";
import { parseMentions } from "zpi-coding-agent/input";
import { chunk, done, send } from "../../../tests/fake-server.ts";
import { fixture } from "./helpers/host-fixture.ts";

it("submits Markdown code examples without treating sample links as required file attachments", async () => {
  const f = await fixture((_, response) => {
    send(response, chunk({ content: "explanation" }));
    done(response);
  });
  const session = f.host.createSession(f.a.id);
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
