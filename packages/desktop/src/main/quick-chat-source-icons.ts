import type { SessionView } from "zpi-ui";
import { normalizeWebToolDetails } from "zpi-ui/projection";
import { publicWebUrl } from "./web-client.ts";

/**
 * Authorize against the current main-process view, never a renderer-supplied view or icon URL.
 * Pass the returned URL only to WebSourceIcons.load, which owns download and image validation.
 */
export function recordedQuickChatWebSourceIcon(
  view: SessionView,
  sessionId: string,
  runId: string,
  sourceUrl: string,
): string | undefined {
  if (
    typeof sessionId !== "string" ||
    !sessionId ||
    sessionId !== view.sessionId ||
    typeof runId !== "string" ||
    !runId ||
    runId.length > 256 ||
    !publicWebUrl(sourceUrl)
  )
    return undefined;
  const run = view.runs.find((run) => run.runId === runId);
  if (!run) return undefined;
  for (const block of run.orderedBlocks) {
    if (block.type !== "tool" || block.name !== "web_search" || block.status !== "completed" || block.isError)
      continue;
    const web = normalizeWebToolDetails(block.web, "web_search");
    if (web?.status !== "success") continue;
    const source = web.results?.find((source) => source.url === sourceUrl && source.site_icon);
    if (source?.site_icon) return source.site_icon;
  }
  return undefined;
}
