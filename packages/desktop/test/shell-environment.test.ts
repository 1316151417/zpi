import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { shellEnvironment } from "../src/main/shell-environment.ts";
import { SettingsStore } from "../src/main/storage.ts";

it("GUI launches recover profile credentials and PATH without overriding explicit credentials or saved models", async () => {
  if (process.platform === "win32") return;
  const dir = await mkdtemp(join(tmpdir(), "zpi-shell-env-"));
  try {
    await writeFile(
      join(dir, ".zshrc"),
      "echo 'profile banner'\nexport DEEPSEEK_API_KEY='isolated-profile-key'\nexport ZHIPU_API_KEY='profile-zhipu'\nexport PATH='/opt/test/bin:/usr/bin:/bin'\nexport ZPI_MULTILINE='first\nsecond=part'\n",
    );
    const base = { SHELL: "/bin/zsh", ZDOTDIR: dir, PATH: "/usr/bin:/bin", ZHIPU_API_KEY: "explicit-key" };
    const env = await shellEnvironment(base);
    expect(env).toMatchObject({
      DEEPSEEK_API_KEY: "isolated-profile-key",
      ZHIPU_API_KEY: "explicit-key",
      PATH: "/opt/test/bin:/usr/bin:/bin",
      ZPI_MULTILINE: "first\nsecond=part",
    });
    expect(env.TERM).toBeUndefined();
    const codec = {
      isEncryptionAvailable: () => true,
      encryptString: (value: string) => Buffer.from(value),
      decryptString: (value: Buffer) => value.toString(),
    };
    const settings = new SettingsStore(dir, codec);
    expect(settings.discoverEnvironment(env)).toEqual(["env-deepseek", "env-zhipu-coding"]);
    const provider = settings.snapshot("env-deepseek");
    settings.saveProvider({ ...provider, models: [] });
    const reopened = new SettingsStore(dir, codec);
    expect(reopened.discoverEnvironment(env)).toEqual([]);
    expect(reopened.snapshot(provider.id).models).toEqual([]);
    expect(await shellEnvironment({ SHELL: join(dir, "missing") })).toEqual({
      SHELL: join(dir, "missing"),
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
