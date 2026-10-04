import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { SessionHost } from "../src/main/session-host.ts";
import { SettingsStore } from "../src/main/storage.ts";
import { cleanup, codec, fixture, png, run } from "./helpers/context-fixture.ts";

test("opaque image ownership, actual image_url, raw visible references, restart preview and no base64 in projection", async () => {
  const f = await fixture();
  await writeFile(join(f.workspace, "hello world.ts"), "let value=1");
  const image = await f.host.importImage(f.session.id, "original.jpg", await png());
  const other = f.host.createSession(null);
  await expect(f.host.readAttachment(other.id, image.id)).rejects.toThrow("不属于");
  await run(f, "Inspect", { attachments: [image.id], fileReferences: ["hello world.ts"] });
  const body = JSON.stringify(f.server.requests[0]);
  expect(body).toContain("image_url");
  expect(body).toContain("data:image/png;base64,");
  expect(body).toContain("Referenced project files");
  const snapshot = f.host.getSessionSnapshot(f.session.id);
  expect(snapshot.view.runs[0]).toMatchObject({
    userMessage: "Inspect",
    attachments: [{ id: image.id, width: 3, height: 2 }],
    fileReferences: ["hello world.ts"],
  });
  expect(JSON.stringify(snapshot)).not.toContain("base64");
  expect(JSON.stringify(snapshot)).not.toContain((await f.host.readAttachment(f.session.id, image.id)).data);
  const restarted = new SessionHost(
    f.dir,
    new SettingsStore(f.dir, codec),
    f.resources,
    f.workspace,
    undefined,
    [],
  );
  await restarted.init();
  cleanup.push(() => restarted.close());
  expect(restarted.getSessionSnapshot(f.session.id).view.runs[0].attachments?.[0].id).toBe(image.id);
  expect((await restarted.readAttachment(f.session.id, image.id)).metadata.name).toBe("original.jpg");
  await f.host.removeAttachment(f.session.id, image.id);
  expect((await f.host.readAttachment(f.session.id, image.id)).data).toBeTruthy();
  await restarted.deleteSession(f.session.id);
  expect(existsSync(join(f.dir, "agent", "attachments", f.session.id))).toBe(false);
});
