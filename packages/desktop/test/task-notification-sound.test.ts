import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { playTaskNotificationSound } from "../src/renderer/task-notification-sound.ts";
import { defaultPreferences } from "../src/shared/config.ts";

const state = vi.hoisted(() => ({
  preferences: { notificationEnabled: true, notificationSoundEnabled: true },
}));
vi.mock("../src/renderer/store.ts", () => ({
  useStore: { getState: () => ({ settings: { interface: state.preferences } }) },
}));
const instances: {
  currentTime: number;
  preload: string;
  pause: ReturnType<typeof vi.fn>;
  play: ReturnType<typeof vi.fn>;
}[] = [];
beforeEach(() => {
  state.preferences = { ...defaultPreferences };
  vi.stubGlobal(
    "Audio",
    class {
      currentTime = 5;
      preload = "";
      pause = vi.fn();
      play = vi.fn().mockResolvedValue(undefined);
      constructor() {
        instances.push(this);
      }
    },
  );
});
afterEach(() => vi.unstubAllGlobals());

it("uses the original sound, reuses the player and resets playback for every displayed notification", async () => {
  await playTaskNotificationSound();
  const audio = instances[0];
  expect(audio.preload).toBe("auto");
  expect(audio.currentTime).toBe(0);
  audio.currentTime = 10;
  await playTaskNotificationSound();
  expect(instances).toHaveLength(1);
  expect(audio.pause).toHaveBeenCalledTimes(2);
  expect(audio.play).toHaveBeenCalledTimes(2);
  expect(audio.currentTime).toBe(0);
  state.preferences.notificationSoundEnabled = false;
  await playTaskNotificationSound();
  state.preferences.notificationSoundEnabled = true;
  state.preferences.notificationEnabled = false;
  await playTaskNotificationSound();
  expect(audio.play).toHaveBeenCalledTimes(2);
  state.preferences.notificationEnabled = true;
  audio.play.mockRejectedValueOnce(new Error("autoplay denied"));
  await expect(playTaskNotificationSound()).resolves.toBeUndefined();
  vi.stubGlobal("Audio", undefined);
  await expect(playTaskNotificationSound()).resolves.toBeUndefined();
  expect(audio.play).toHaveBeenCalledTimes(3);
});
