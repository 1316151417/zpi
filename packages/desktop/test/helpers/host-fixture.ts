import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "vitest";
import { fakeServer } from "../../../../tests/fake-server.ts";
import { SessionHost } from "../../src/main/session-host.ts";
import { SettingsStore } from "../../src/main/storage.ts";
export const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  await Promise.allSettled(
    cleanup
      .splice(0)
      .reverse()
      .map((f) => f()),
  );
});
export async function fixture(handler: Parameters<typeof fakeServer>[0]) {
  const dir = await mkdtemp(join(tmpdir(), "ZPI-host-"));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const server = await fakeServer(handler);
  cleanup.push(server.close);
  const settings = new SettingsStore(dir, {
    isEncryptionAvailable: () => false,
    encryptString: () => Buffer.alloc(0),
    decryptString: () => "",
  });
  settings.save({
    baseUrl: server.url,
    modelId: "fake",
    apiKey: "secret-host",
    headers: { "X-Auth": "secret-header" },
    supportsImages: false,
    reasoning: true,
    compat: { supportsReasoningEffort: true },
    contextWindow: 32768,
    maxTokens: 4096,
  });
  settings.rememberSelection({ provider: "custom", modelId: "fake", reasoning: "none" });
  const host = new SessionHost(dir, settings, join(dir, "agent"), undefined, undefined, []);
  await host.init();
  cleanup.push(() => host.close());
  const aDir = join(dir, "a"),
    bDir = join(dir, "b");
  await mkdir(aDir);
  await mkdir(bDir);
  const a = await host.addProject(aDir);
  const b = await host.addProject(bDir);
  return { host, settings, server, dir, a, b };
}
