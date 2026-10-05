import taskNotificationPopUrl from "./assets/notification-sounds/task-notification-pop.mp3?url";
import { useStore } from "./store.ts";

let audio: HTMLAudioElement | null = null;

// Same asset and playback behavior as ZCode taskNotificationSound.ts.
export async function playTaskNotificationSound(): Promise<void> {
  const preferences = useStore.getState().settings?.interface;
  if (
    !preferences?.notificationEnabled ||
    !preferences.notificationSoundEnabled ||
    typeof Audio === "undefined"
  )
    return;
  try {
    if (!audio) {
      audio = new Audio(taskNotificationPopUrl);
      audio.preload = "auto";
    }
    audio.pause();
    audio.currentTime = 0;
    await audio.play();
  } catch {
    // Autoplay restrictions or unavailable audio never interrupt the task UI.
  }
}
