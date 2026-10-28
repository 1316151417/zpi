import { expect, test, vi } from "vitest";
import { searchFiles } from "../src/main/workspace-files.ts";
import { fixture } from "./helpers/host-fixture.ts";

vi.mock("../src/main/workspace-files.ts", async (original) => ({
  ...(await original<typeof import("../src/main/workspace-files.ts")>()),
  searchFiles: vi.fn(),
}));

test("file mentions cancel superseded scans and close cancels independent searches", async () => {
  const f = await fixture(() => {});
  const id = (await f.host.createSession(f.a.id)).id;
  const signals: AbortSignal[] = [];
  vi.mocked(searchFiles).mockImplementation(
    async (_cwd, _query, signal) =>
      new Promise((resolve) => {
        if (!signal) throw new Error("Missing cancellation signal");
        signals.push(signal);
        signal.addEventListener("abort", () => resolve([]), { once: true });
      }),
  );
  const first = f.host.searchFiles(id, "first");
  const second = f.host.searchFiles(id, "second");
  expect(signals[0].aborted).toBe(true);
  await first;
  const otherId = (await f.host.createSession(f.a.id)).id;
  const mention = f.host.searchFiles(otherId, "readme");
  expect(signals[1].aborted).toBe(false);
  expect(signals[2].aborted).toBe(false);
  await f.host.close();
  await Promise.all([second, mention]);
  expect(signals.every((signal) => signal.aborted)).toBe(true);
});

test("notification titles include only visible top-level sessions", async () => {
  const f = await fixture(() => {});
  const root = await f.host.createSession(f.a.id);
  const child = await f.host.createSession(f.a.id, { parentSessionId: root.id });
  expect(f.host.notificationTitle(root.id)).toBe(root.title);
  expect(f.host.notificationTitle(child.id)).toBeUndefined();
  expect(f.host.notificationTitle("missing")).toBeUndefined();
  await f.host.archiveSession(root.id);
  expect(f.host.notificationTitle(root.id)).toBeUndefined();
});
