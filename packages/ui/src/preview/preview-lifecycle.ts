import type { RunStatus } from "../types.ts";
import {
  type AssistantPreviewCard,
  type AssistantPreviewCardFileStatService,
  buildAssistantPreviewCardsFromReferences,
  extractAssistantFileReferences,
} from "./assistant-preview-cards.ts";
import { resolveValidatedAssistantPreviewCards } from "./assistant-preview-validation.ts";
export interface PreviewInput {
  sessionId: string;
  runId: string;
  text: string;
  cwd: string;
  home?: string;
}
export interface PreviewServices {
  listOpenApps(): Promise<Array<{ id: string; name: string; iconDataUrl: string }>>;
  openWith(sessionId: string, path: string, appId: string): Promise<void>;
  load(input: PreviewInput): Promise<AssistantPreviewCard[]>;
  openFile(sessionId: string, path: string): Promise<void>;
  openWebsite(sessionId: string, url: string): Promise<void>;
  openExternal(sessionId: string, url: string, localPath?: string): Promise<void>;
  fileAction(
    sessionId: string,
    path: string,
    action: "open" | "copy-absolute" | "copy-relative",
  ): Promise<void>;
}
export function previewInputKey(input: PreviewInput): string {
  return JSON.stringify([input.sessionId, input.runId, input.cwd, input.home ?? "", input.text]);
}
export function createPreviewLoader(services: {
  checkFilesExist(
    params: { paths: string[] },
    sessionId: string,
  ): ReturnType<AssistantPreviewCardFileStatService["checkFilesExist"]>;
  getChangedPaths(sessionId: string, runId: string): Promise<string[]>;
}) {
  // Coalesce in-flight projections. File existence can change while a conversation
  // is unmounted; mounted rows own their settled snapshots and remounts revalidate.
  const requests = new Map<string, Promise<AssistantPreviewCard[]>>();
  return {
    clear(sessionId?: string) {
      for (const key of requests.keys())
        if (!sessionId || (JSON.parse(key) as string[])[0] === sessionId) requests.delete(key);
    },
    load(input: PreviewInput) {
      const key = previewInputKey(input);
      const cached = requests.get(key);
      if (cached) return cached;
      const request = (async () => {
        const references = extractAssistantFileReferences(input.text, input.cwd, { homePath: input.home });
        const needsChanges = references.some((ref) => ref.kind === "markdown" || ref.kind === "html");
        const changedFilePaths = needsChanges
          ? await services.getChangedPaths(input.sessionId, input.runId).catch(() => [])
          : [];
        const candidates = buildAssistantPreviewCardsFromReferences(input.text, input.cwd, references, {
          changedFilePaths,
          homePath: input.home,
        });
        return resolveValidatedAssistantPreviewCards(candidates, {
          checkFilesExist: (params) => services.checkFilesExist(params, input.sessionId),
        }).catch(() => []);
      })().finally(() => {
        if (requests.get(key) === request) requests.delete(key);
      });
      requests.set(key, request);
      return request;
    },
  };
}
export interface PreviewAutoOpenState {
  scope: string;
  armed: boolean;
}
export function advancePreviewAutoOpen(
  previous: PreviewAutoOpenState,
  scope: string,
  status: RunStatus | undefined,
  runId?: string,
): { state: PreviewAutoOpenState; target?: string | null } {
  const changed = previous.scope !== scope;
  const current = changed ? { scope, armed: false } : previous;
  if (status === "running") return { state: { scope, armed: true }, target: null };
  if (status !== "completed")
    return { state: { scope, armed: false }, ...(changed || current.armed ? { target: null } : {}) };
  if (!current.armed || !runId) return { state: current, ...(changed ? { target: null } : {}) };
  return { state: { scope, armed: false }, target: `${scope}:${runId}` };
}
