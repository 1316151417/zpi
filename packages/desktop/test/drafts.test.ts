import { join } from "node:path";
import { expect, it } from "vitest";
import { SessionHost } from "../src/main/session-host.ts";
import { cleanup, setup } from "./helpers/session-fixture.ts";

it("text drafts persist with selection, reject stale writes, and retain invalid links with diagnostics", async () => {
  const { host, dir, cwd, settings } = await setup();
  const a = host.createSession(null),
    b = host.createSession(null);
  const text = `中文 [missing](${cwd}/missing.txt) [$skill](${cwd}/missing/SKILL.md)`;
  host.saveDraft(a.id, { text, fileReferences: [], selection: [2, 2], revision: 2 });
  host.saveDraft(a.id, { text: "stale", fileReferences: [], selection: [0, 0], revision: 1 });
  host.saveDraft(b.id, { text: "会话 B", fileReferences: [], selection: [4, 4], revision: 1 });
  await host.close();
  const reopened = new SessionHost(dir, settings, join(dir, "resources"), cwd, undefined, []);
  await reopened.init();
  cleanup.push(() => reopened.close());
  expect(await reopened.getDraft(a.id)).toMatchObject({
    text,
    selection: [2, 2],
    warnings: [expect.stringContaining("missing.txt"), expect.stringContaining("SKILL.md")],
  });
  expect((await reopened.getDraft(b.id)).text).toBe("会话 B");
  await reopened.deleteSession(a.id);
  expect(() =>
    reopened.saveDraft(a.id, { text: "resurrect", fileReferences: [], selection: [0, 0], revision: 3 }),
  ).toThrow();
});
