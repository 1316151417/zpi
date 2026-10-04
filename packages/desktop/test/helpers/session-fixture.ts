import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "vitest";
import { chunk, done, fakeServer, send } from "../../../../tests/fake-server.ts";
import { SessionHost } from "../../src/main/session-host.ts";
import { SettingsStore } from "../../src/main/storage.ts";
export const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f();
});
export async function setup(title?: Parameters<typeof fakeServer>[1]) {
  const dir = await mkdtemp(join(tmpdir(), "zpi-session-metadata-"));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const cwd = join(dir, "workspace");
  await mkdir(cwd);
  const server = await fakeServer((_, res) => {
    send(res, chunk({ content: "完整回复" }));
    done(res);
  }, title);
  cleanup.push(server.close);
  const settings = new SettingsStore(dir, {
    isEncryptionAvailable: () => false,
    encryptString: () => Buffer.alloc(0),
    decryptString: () => "",
  });
  settings.save({
    baseUrl: server.url,
    modelId: "fake",
    supportsImages: true,
    reasoning: false,
    contextWindow: 1000000,
    maxTokens: 4096,
    compat: { structuredOutput: "json_schema" },
  });
  settings.rememberSelection({ provider: "custom", modelId: "fake", reasoning: "disabled" });
  const host = new SessionHost(dir, settings, join(dir, "resources"), cwd, undefined, []);
  await host.init();
  cleanup.push(() => host.close());
  return { dir, cwd, host, settings, server };
}
export async function idle(host: SessionHost, id: string) {
  await host.activeRuns.get(id)?.done;
}
