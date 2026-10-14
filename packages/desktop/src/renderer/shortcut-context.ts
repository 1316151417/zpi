/** Hidden retained panes must not act as application-wide modal shortcut blockers. */
export function hasVisibleShortcutBlocker(selector: string): boolean {
  return [...document.querySelectorAll<HTMLElement>(selector)].some((element) => {
    if (element.closest('[hidden], [inert], [aria-hidden="true"]') || !element.getClientRects().length)
      return false;
    const visibility = getComputedStyle(element).visibility;
    return visibility !== "hidden" && visibility !== "collapse";
  });
}
