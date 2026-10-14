export function taskShortcut(event: KeyboardEvent, platform: string): "new-task" | "search" | undefined {
  if (
    event.defaultPrevented ||
    event.isComposing ||
    event.keyCode === 229 ||
    !(event.metaKey || event.ctrlKey) ||
    event.altKey ||
    event.shiftKey
  )
    return;
  switch (event.key.toLowerCase()) {
    case "n":
      return !event.repeat && (platform === "darwin" ? event.metaKey : event.ctrlKey)
        ? "new-task"
        : undefined;
    case "k":
      return "search";
  }
}
