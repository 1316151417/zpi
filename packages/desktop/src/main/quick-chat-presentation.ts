/** Only resume can retire the one-presentation allowance from an explicit new chat.
 * Unknown renderer state preserves drafts; compact drafts never expand on their own. */
export function resumeQuickChatExpanded(expanded: boolean, hasRuns: boolean, occupied?: boolean): boolean {
  return hasRuns || (expanded && occupied !== false);
}
