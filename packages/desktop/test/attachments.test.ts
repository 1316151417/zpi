import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { AttachmentStore } from "../src/main/attachments.ts";
import { SessionHost } from "../src/main/session-host.ts";
import { SettingsStore } from "../src/main/storage.ts";
import { cleanup, codec, fixture, png, run } from "./helpers/context-fixture.ts";

test("invalid cache directories and damaged indexes do not block startup or cleanup of other sessions", async () => {
  const f = await fixture();
  const root = join(f.dir, "agent", "attachments");
  await mkdir(join(root, "invalid directory"));
  await mkdir(join(root, "damaged"));
  await writeFile(join(root, "damaged", "index.json"), "{broken");
  await writeFile(join(root, "damaged", "keep.png"), "preserve");
  const image = await f.host.importImage(f.session.id, "unsent.png", await png());
  await f.host.close();
  const reopened = new SessionHost(f.dir, f.settings, f.resources, f.workspace, undefined, []);
  await reopened.init();
  cleanup.push(() => reopened.close());
  expect(reopened.listRecentSessions().map((record) => record.id)).toContain(f.session.id);
  expect(await readFile(join(root, "damaged", "index.json"), "utf8")).toBe("{broken");
  expect(existsSync(join(root, "damaged", "keep.png"))).toBe(true);
  expect(existsSync(join(root, f.session.id, `${image.id}.png`))).toBe(false);
});

test("attachment IDs loaded from disk cannot escape the owning session during reads or copies", async () => {
  const f = await fixture();
  const root = join(f.dir, "agent", "attachments");
  await mkdir(join(root, "source"));
  await writeFile(join(root, "outside.png"), "private");
  await writeFile(
    join(root, "source", "index.json"),
    JSON.stringify([
      { id: "../outside", name: "image", mimeType: "image/png", width: 1, height: 1, size: 7, used: true },
    ]),
  );
  const store = new AttachmentStore(root);
  await expect(store.read("source", "../outside")).rejects.toThrow("无效附件 ID");
  await expect(store.copyTo("source", "target", ["../outside"])).rejects.toThrow("无效附件 ID");
  expect(await readFile(join(root, "outside.png"), "utf8")).toBe("private");
  expect(existsSync(join(root, "target", "index.json"))).toBe(false);
});

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
