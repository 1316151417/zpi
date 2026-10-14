import { randomFillSync } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";
import { expect, test } from "vitest";
import { createReadTool } from "zpi-coding-agent";
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
  const reopened = new SessionHost(f.dir, f.settings, f.resources, f.workspace, undefined);
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

test("file attachments work with text-only models, include bounded text and preserve binary files by path", async () => {
  const f = await fixture();
  await f.host.setSessionSelection(f.session.id, { provider: "p", modelId: "plain", reasoning: "none" });
  const textPath = join(f.dir, "outside-workspace.txt");
  const pdfPath = join(f.dir, "document.pdf");
  await writeFile(textPath, "attachment content\n".repeat(3000));
  await writeFile(pdfPath, "%PDF-1.7\n\0binary payload");
  const text = await f.host.importFile(f.session.id, textPath);
  const pdf = await f.host.importFile(f.session.id, pdfPath);
  expect(text).toMatchObject({
    name: "outside-workspace.txt",
    path: await realpath(textPath),
    mimeType: "text/plain",
  });
  expect(pdf).toMatchObject({
    name: "document.pdf",
    path: await realpath(pdfPath),
    mimeType: "application/pdf",
  });
  const other = f.host.createSession(null);
  await expect(f.host.readAttachment(other.id, pdf.id)).rejects.toThrow("不属于");
  await run(f, "Read the attachments", { attachments: [text.id, pdf.id] });
  const body = JSON.stringify(f.server.requests[0]);
  expect(body).toContain("attachment content");
  expect(body).toContain("Showing lines 1-2000");
  expect(body).toContain(await realpath(pdfPath));
  expect(body).not.toContain("binary payload");
  expect(body).not.toContain("image_url");
  expect(body).not.toContain("base64");
  expect(f.host.getSessionSnapshot(f.session.id).view.runs[0].attachments).toHaveLength(2);
  await f.host.deleteSession(f.session.id);
  expect(await readFile(pdfPath, "utf8")).toContain("%PDF");
  expect(await readFile(textPath, "utf8")).toContain("attachment content");
});

test("file picker imports are bounded by attachment count, validate files and never remove originals", async () => {
  const f = await fixture();
  await expect(f.host.importFile(f.session.id, f.workspace)).rejects.toThrow("文件");
  await expect(f.host.importFile(f.session.id, join(f.dir, "missing.txt"))).rejects.toThrow("ENOENT");
  for (let i = 0; i < 8; i++) {
    const path = join(f.dir, `file-${i}.json`);
    await writeFile(path, "{}");
    await f.host.importFile(f.session.id, path);
  }
  const path = join(f.dir, "ninth.csv");
  await writeFile(path, "a,b");
  await expect(f.host.importFile(f.session.id, path)).rejects.toThrow("8");
  await f.host.attachments.cleanUnsent();
  expect(await readFile(join(f.dir, "file-0.json"), "utf8")).toBe("{}");
});

test("pasted files survive restart and copies, clean up their own cache and do not inject disguised binary text", async () => {
  const f = await fixture();
  const text = await f.host.importAttachment(f.session.id, "pasted.txt", Buffer.from("pasted file content"));
  const binary = await f.host.importAttachment(f.session.id, "binary.txt", Buffer.from("\0binary payload"));
  const unsent = await f.host.importAttachment(f.session.id, "unsent.txt", Buffer.from("unsent"));
  const cached = (await f.host.readAttachment(f.session.id, text.id)).metadata;
  if (!("path" in cached)) throw Error("Expected file attachment");
  await run(f, "Inspect files", { attachments: [text.id, binary.id] });
  expect(JSON.stringify(f.server.requests[0])).toContain("pasted file content");
  expect(JSON.stringify(f.server.requests[0])).not.toContain("binary payload");
  const root = join(f.dir, "agent", "attachments");
  const store = new AttachmentStore(root);
  await store.cleanUnsent();
  expect(existsSync(join(root, f.session.id, `${unsent.id}.file`))).toBe(false);
  expect(existsSync(cached.path)).toBe(true);
  await store.copyTo(f.session.id, "fork", [text.id, binary.id]);
  await store.deleteSession(f.session.id);
  const reopened = new AttachmentStore(root);
  const copied = (await reopened.read("fork", text.id)).metadata;
  if (!("path" in copied)) throw Error("Expected file attachment");
  expect(copied.path).toBe(join(root, "fork", `${text.id}.file`));
  expect(await readFile(copied.path, "utf8")).toBe("pasted file content");
  expect((await reopened.load("fork", [text.id])).fileContext).toContain("pasted file content");
  await reopened.deleteSession("fork");
  expect(existsSync(copied.path)).toBe(false);
});

test("large native text attachments use bounded previews while the original remains readable", async () => {
  const f = await fixture();
  const path = join(f.dir, "large.log");
  await writeFile(path, `${"中文 log\n".repeat(40_000)}last line`);
  const file = await f.host.importFile(f.session.id, path);
  const loaded = await f.host.attachments.load(f.session.id, [file.id]);
  expect(loaded.fileContext).toContain("中文 log");
  expect(loaded.fileContext).toContain("Partial attachment preview");
  expect(loaded.fileContext).not.toContain("last line");
  expect(Buffer.byteLength(loaded.fileContext)).toBeLessThan(55 * 1024);
  expect(await readFile(path, "utf8")).toContain("last line");
});

test("image previews retain originals while sending the same bounded payload as read", async () => {
  const f = await fixture();
  const original = await sharp({ create: { width: 3000, height: 2, channels: 3, background: "red" } })
    .jpeg()
    .toBuffer();
  const path = join(f.dir, "wide.jpg");
  await writeFile(path, original);
  const image = await f.host.importFile(f.session.id, path);
  expect(image).toMatchObject({ mimeType: "image/jpeg", width: 3000, height: 2, size: original.length });
  const root = join(f.dir, "agent", "attachments");
  const indexPath = join(root, f.session.id, "index.json");
  const index = JSON.parse(await readFile(indexPath, "utf8"));
  index[0].width = 1;
  index[0].height = 1;
  index[0].size = 1;
  await writeFile(indexPath, JSON.stringify(index));
  const loaded = await f.host.attachments.load(f.session.id, [image.id]);
  expect(loaded.metadata[0]).toMatchObject({ width: 3000, height: 2, size: original.length });
  expect(loaded.fileContext).toContain("original 3000x2, displayed at 2000x1");
  expect(loaded.fileContext).toContain("1.50 horizontally and 2.00 vertically");
  const read = await createReadTool(f.workspace).execute("image", { path });
  expect(loaded.images).toEqual(read.content.filter((part) => part.type === "image"));
  expect((await f.host.readAttachment(f.session.id, image.id)).data).toBe(original.toString("base64"));
  await f.host.attachments.copyTo(f.session.id, "image-copy", [image.id]);
  const reopened = new AttachmentStore(root);
  expect((await reopened.read("image-copy", image.id)).data).toBe(original.toString("base64"));
  expect((await reopened.load("image-copy", [image.id])).images).toEqual(loaded.images);
  await reopened.cleanUnsent();
  expect(existsSync(join(root, f.session.id, `${image.id}.jpg`))).toBe(false);
  expect(existsSync(join(root, "image-copy", `${image.id}.jpg`))).toBe(true);
  expect((await readFile(path)).equals(original)).toBe(true);
});

test("cached legacy PNGs are revalidated and resized instead of trusting stale indexes", async () => {
  const f = await fixture();
  const original = await sharp({ create: { width: 2400, height: 1200, channels: 3, background: "red" } })
    .png()
    .toBuffer();
  const image = await f.host.importImage(f.session.id, "legacy.png", original);
  const root = join(f.dir, "agent", "attachments", f.session.id);
  const indexPath = join(root, "index.json");
  const index = JSON.parse(await readFile(indexPath, "utf8"));
  index[0].width = 100_000;
  index[0].height = 100_000;
  index[0].warning = "stale animation warning";
  await writeFile(indexPath, JSON.stringify(index));
  const loaded = await f.host.attachments.load(f.session.id, [image.id]);
  expect(loaded.metadata[0]).toMatchObject({ width: 2400, height: 1200 });
  expect(loaded.metadata[0]).not.toHaveProperty("warning");
  expect(await sharp(Buffer.from(loaded.images[0].data, "base64")).metadata()).toMatchObject({
    width: 2000,
    height: 1000,
  });
  await writeFile(join(root, `${image.id}.png`), original.subarray(0, 40));
  await expect(f.host.attachments.load(f.session.id, [image.id])).rejects.toThrow();
});

test("the provider receives a bounded encoding while the attachment cache keeps a large original", async () => {
  const f = await fixture();
  const original = await sharp(randomFillSync(Buffer.alloc(1600 * 1600 * 3)), {
    raw: { width: 1600, height: 1600, channels: 3 },
  })
    .png()
    .toBuffer();
  expect(original.toString("base64").length).toBeGreaterThan(4.5 * 1024 * 1024);
  const image = await f.host.importImage(f.session.id, "large.png", original);
  await run(f, "Inspect the large image", { attachments: [image.id] });
  expect(f.server.requests).toHaveLength(1);
  const body = JSON.stringify(f.server.requests[0]);
  const payload = /data:image\/jpeg;base64,([A-Za-z0-9+/=]+)/.exec(body)?.[1];
  expect(payload).toBeDefined();
  if (!payload) return;
  expect(payload.length).toBeLessThanOrEqual(4.5 * 1024 * 1024);
  expect(await sharp(Buffer.from(payload, "base64")).metadata()).toMatchObject({ width: 1600, height: 1600 });
  expect((await f.host.readAttachment(f.session.id, image.id)).data).toBe(original.toString("base64"));
});
