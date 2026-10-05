import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterEach } from "vitest";
import type { PromptTemplate } from "zpi-coding-agent";
import { chunk, done, fakeServer, send } from "../../../../tests/fake-server.ts";
import { SessionHost } from "../../src/main/session-host.ts";
import { SettingsStore } from "../../src/main/storage.ts";
export const codec = {
  isEncryptionAvailable: () => true,
  encryptString: (s: string) => Buffer.from(s),
  decryptString: (b: Buffer) => b.toString(),
};
export const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const action of cleanup.splice(0).reverse()) await action();
});
export async function fixture(
  handler: Parameters<typeof fakeServer>[0] = (_, r) => {
    send(r, chunk({ content: "ok" }));
    done(r);
  },
  legacyTemplate?: PromptTemplate,
) {
  const dir = await mkdtemp(join(tmpdir(), "zpi-context-"));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const server = await fakeServer(handler);
  cleanup.push(server.close);
  let settings = new SettingsStore(dir, codec);
  settings.saveProvider({
    id: "p",
    name: "Provider",
    baseUrl: server.url,
    apiKey: "",
    models: [
      { id: "vision", input: ["text", "image"] },
      { id: "plain", input: ["text"] },
    ],
  });
  settings.rememberSelection({ provider: "p", modelId: "vision", reasoning: "none" });
  if (legacyTemplate) {
    const file = join(dir, "settings.json");
    const data = JSON.parse(await readFile(file, "utf8"));
    await writeFile(
      file,
      JSON.stringify({ ...data, templates: [legacyTemplate], selectedTemplateId: legacyTemplate.id }),
    );
    settings = new SettingsStore(dir, codec);
  }
  const workspace = join(dir, "workspace"),
    resources = join(dir, "resources"),
    host = new SessionHost(dir, settings, resources, workspace, undefined, []);
  await host.init();
  cleanup.push(() => host.close());
  const session = host.createSession(null);
  return { dir, workspace, resources, host, session, settings, server };
}
export async function png() {
  return sharp({ create: { width: 3, height: 2, channels: 3, background: "red" } })
    .png()
    .toBuffer();
}
export async function run(
  f: Awaited<ReturnType<typeof fixture>>,
  text: string,
  extra: { attachments?: string[]; fileReferences?: string[] } = {},
) {
  await f.host.startRun({ sessionId: f.session.id, text, ...extra });
  await f.host.activeRuns.get(f.session.id)?.done;
}
