import type { ImageAttachment } from "zpi-coding-agent/input";
import type { SessionView } from "zpi-ui";
import type { CombinedSelection, PublicSettings, Result } from "./bridge.ts";

export interface QuickChatSnapshot {
  revision: number;
  session: SessionView;
  settings: PublicSettings;
  selection: CombinedSelection | null;
  cwd: string;
  expanded?: boolean;
  presentationVersion?: number;
}
/** Only this bridge is exposed to the temporary window. No task or privileged desktop API. */
export interface QuickChatBridge {
  getSnapshot(): Promise<Result<QuickChatSnapshot>>;
  send(text: string, attachments?: string[]): Promise<Result<void>>;
  importAttachment(sessionId: string, file: File): Promise<Result<ImageAttachment>>;
  readAttachment(sessionId: string, id: string): Promise<Result<{ metadata: ImageAttachment; data: string }>>;
  removeAttachment(sessionId: string, id: string): Promise<Result<void>>;
  stop(): Promise<Result<void>>;
  reset(): Promise<Result<void>>;
  hide(): Promise<Result<void>>;
  setComposerHeight(sessionId: string, height: number): Promise<Result<void>>;
  setNoticeHeight(sessionId: string, height: number): Promise<Result<void>>;
  rendererReady(sessionId: string, presentationVersion: number): Promise<Result<void>>;
  rendererCommitted(sessionId: string, presentationVersion: number): Promise<Result<void>>;
  onComposerProbe(listener: (token: number, sessionId: string) => void): () => void;
  reportComposerState(token: number, sessionId: string, occupied: boolean): Promise<Result<void>>;
  onPresentation(listener: (token: number) => void): () => void;
  reportPresentation(
    token: number,
    stage: "renderer-ready" | "renderer-focus" | "renderer-frame",
  ): Promise<Result<void>>;
  copyText(text: string): Promise<Result<void>>;
  openExternal(url: string): Promise<Result<void>>;
  readWebSourceIcon(
    sessionId: string,
    runId: string,
    sourceUrl: string,
  ): Promise<Result<{ dataUrl?: string }>>;
  onSnapshot(listener: (snapshot: QuickChatSnapshot) => void): () => void;
}
