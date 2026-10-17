import { Conversation, type SessionView } from "zpi-ui";
import { unwrap } from "./unwrap.ts";

export interface QuickChatConversationProps {
  view: SessionView;
  onError: (message: string) => void;
}

const readWebSourceIcon = async (sessionId: string, runId: string, sourceUrl: string) =>
  unwrap(await window.zpiQuickChat.readWebSourceIcon(sessionId, runId, sourceUrl)).dataUrl;

export default function QuickChatConversation({ view, onError }: QuickChatConversationProps) {
  return (
    <Conversation
      view={view}
      persistReading={false}
      readWebSourceIcon={readWebSourceIcon}
      onCopy={(text) => window.zpiQuickChat.copyText(text).then(unwrap)}
      onLink={(url) => {
        void window.zpiQuickChat
          .openExternal(url)
          .then(unwrap)
          .catch((reason) => onError(reason instanceof Error ? reason.message : String(reason)));
      }}
      onFile={() => onError("快速对话不支持预览本地文件")}
    />
  );
}
