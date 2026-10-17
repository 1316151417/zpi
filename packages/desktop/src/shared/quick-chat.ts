import type { SessionView } from "zpi-ui";
import type { CombinedSelection, PublicSettings, Result } from "./bridge.ts";

export interface QuickChatSnapshot {
  revision: number;
  session: SessionView;
  settings: PublicSettings;
  selection: CombinedSelection | null;
  cwd: string;
}
/** Only this bridge is exposed to the temporary window. No task or privileged desktop API. */
export interface QuickChatBridge {
  getSnapshot(): Promise<Result<QuickChatSnapshot>>;
  send(text: string): Promise<Result<void>>;
  stop(): Promise<Result<void>>;
  reset(): Promise<Result<void>>;
  hide(): Promise<Result<void>>;
  copyText(text: string): Promise<Result<void>>;
  openExternal(url: string): Promise<Result<void>>;
  readWebSourceIcon(
    sessionId: string,
    runId: string,
    sourceUrl: string,
  ): Promise<Result<{ dataUrl?: string }>>;
  onSnapshot(listener: (snapshot: QuickChatSnapshot) => void): () => void;
}
