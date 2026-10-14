import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { expect, it } from "vitest";
import { AttachmentStore } from "../src/main/attachments.ts";

it("merges repeated and concurrent fork copy batches and owns all bytes after source deletion", async () => {
  const root = await mkdtemp(join(tmpdir(), "zpi-attachment-copy-"));
  try {
    const store = new AttachmentStore(root);
    const text = await store.importBytes("source", "first.txt", Buffer.from("first batch"));
    const binary = await store.importBytes("source", "second.bin", Buffer.from([0, 1, 2]));
    const bytes = await sharp({ create: { width: 2, height: 2, channels: 3, background: "red" } })
      .png()
      .toBuffer();
    const image = await store.import("source", "image.png", bytes);
    const first = await store.copyTo("source", "target", [text.id]);
    const [second, repeated] = await Promise.all([
      store.copyTo("source", "target", [binary.id, image.id]),
      store.copyTo("source", "target", [text.id, text.id]),
    ]);
    expect(repeated).toEqual(first);
    expect(second.size).toBe(1);
    const metadata = JSON.parse(await readFile(join(root, "target", "index.json"), "utf8"));
    expect(metadata.map((item: { id: string }) => item.id)).toEqual([text.id, binary.id, image.id]);
    await store.deleteSession("source");
    const reopened = new AttachmentStore(root);
    await reopened.cleanUnsent();
    expect((await reopened.load("target", [text.id])).fileContext).toContain("first batch");
    const copied = (await reopened.read("target", binary.id)).metadata;
    if (!("path" in copied)) throw new Error("expected file attachment");
    expect(await readFile(copied.path)).toEqual(Buffer.from([0, 1, 2]));
    expect((await reopened.read("target", image.id)).data).toBe(bytes.toString("base64"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
