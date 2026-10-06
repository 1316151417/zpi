import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, vi } from "vitest";
export const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(cleanup.splice(0).map((f) => f()));
});
export async function directory() {
  const dir = await mkdtemp(join(tmpdir(), "ZPI-sdk-"));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
