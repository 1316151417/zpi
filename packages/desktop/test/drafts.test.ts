import { join } from "node:path";
import { expect, it } from "vitest";
import { SessionHost } from "../src/main/session-host.ts";
import { cleanup, setup } from "./helpers/session-fixture.ts";

it("ignores legacy JSON drafts and retains SQLite state", async () => {
  const { host, dir } = await setup();
  const id = (await host.createSession(null)).id;
  host.saveDraft(id, { text: "original", fileReferences: [], selection: [0, 0], revision: 1 });
  await mkdir(join(dir, "drafts"), { recursive: true });
  const path = join(dir, "drafts", `${id}.json`);
  await writeFile(path, "{broken legacy draft");
  expect(await host.getDraft(id)).toMatchObject({ text: "original", revision: 1 });
  expect(await readFile(path, "utf8")).toBe("{broken legacy draft");
});

it("text drafts persist with selection, reject stale writes, and retain invalid links with diagnostics", async () => {
  const { host, dir, cwd, settings } = await setup();
  const a = await host.createSession(null),
    b = await host.createSession(null);
  const text = `中文 [missing](${cwd}/missing.txt) [$skill](${cwd}/missing/SKILL.md)`;
  host.saveDraft(a.id, { text, fileReferences: [], selection: [2, 2], revision: 2 });
  host.saveDraft(a.id, { text: "stale", fileReferences: [], selection: [0, 0], revision: 1 });
  host.saveDraft(b.id, { text: "会话 B", fileReferences: [], selection: [4, 4], revision: 1 });
  await host.close();
  const reopened = new SessionHost(dir, settings, join(dir, "resources"), cwd, undefined);
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

import { mkdir, readFile, writeFile } from "node:fs/promises";
