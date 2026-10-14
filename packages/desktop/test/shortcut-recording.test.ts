import { expect, it } from "vitest";
import { ShortcutRecordingRequest } from "../src/renderer/shortcut-recording.ts";

function pending() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

it("ignores a late native capture acknowledgement after blur or unmount", async () => {
  const recording = new ShortcutRecordingRequest();
  const request = pending();
  const result = recording.start(() => request.promise);
  recording.cancel();
  request.resolve();
  expect(await result).toBe(false);
  expect(await recording.start(async () => {})).toBe(true);
});

it("keeps the newest recording when capture acknowledgements arrive out of order", async () => {
  const recording = new ShortcutRecordingRequest();
  const first = pending();
  const older = recording.start(() => first.promise);
  expect(await recording.start(async () => {})).toBe(true);
  first.resolve();
  expect(await older).toBe(false);
});

it("reports current capture failures while discarding failures from canceled requests", async () => {
  const recording = new ShortcutRecordingRequest();
  await expect(
    recording.start(async () => {
      throw Error("capture failed");
    }),
  ).rejects.toThrow("capture failed");
  const request = pending();
  const result = recording.start(() => request.promise);
  recording.cancel();
  request.reject(Error("stale failure"));
  expect(await result).toBe(false);
});
