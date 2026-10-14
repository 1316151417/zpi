/** Hidden retained panes must not act as application-wide modal shortcut blockers. */
export function isVisibleShortcutTarget(element: Element): boolean {
  if (element.closest('[hidden], [inert], [aria-hidden="true"]') || !element.getClientRects().length)
    return false;
  const visibility = getComputedStyle(element).visibility;
  return visibility !== "hidden" && visibility !== "collapse";
}

export function hasVisibleShortcutBlocker(selector: string): boolean {
  return [...document.querySelectorAll<HTMLElement>(selector)].some(isVisibleShortcutTarget);
}

/** Electron normally keeps DOM focus across hide/show. Leave that target and its selection untouched. */
export function hasRestorableFocus(): boolean {
  const active = document.activeElement;
  return Boolean(
    active &&
      active !== document.body &&
      active !== document.documentElement &&
      active.isConnected &&
      !active.matches(":disabled") &&
      isVisibleShortcutTarget(active),
  );
}
