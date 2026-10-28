import { useMemo } from "react";
import { type ComposerContext, Conversation, type SessionView } from "zpi-ui";
import { readQuickChatAttachment } from "./quick-chat-attachments.ts";
import { unwrap } from "./unwrap.ts";
import { userErrorMessage } from "./user-error.ts";

export interface QuickChatConversationProps {
  view: SessionView;
  cwd: string;
  onError: (message: string) => void;
}

const readWebSourceIcon = async (sessionId: string, runId: string, sourceUrl: string) =>
  unwrap(await window.zpiQuickChat.readWebSourceIcon(sessionId, runId, sourceUrl)).dataUrl;

const unavailable = async () => {
  throw new Error("快速对话不支持选择本地文件");
};
const attachmentContext: ComposerContext = {
  searchFiles: unavailable,
  pickAttachments: unavailable,
  importAttachment: (sessionId, file) => window.zpiQuickChat.importAttachment(sessionId, file).then(unwrap),
  removeAttachment: (sessionId, id) => window.zpiQuickChat.removeAttachment(sessionId, id).then(unwrap),
  readAttachment: readQuickChatAttachment,
};

export default function QuickChatConversation({ view, cwd, onError }: QuickChatConversationProps) {
  const workspace = useMemo(() => ({ cwd }), [cwd]);
  return (
    <Conversation
      onRetryModel={(runId) => window.zpiQuickChat.retryModelRequest(view.sessionId, runId).then(unwrap)}
      view={view}
      persistReading={false}
      workspace={workspace}
      context={attachmentContext}
      readWebSourceIcon={readWebSourceIcon}
      onCopy={(text) => window.zpiQuickChat.copyText(text).then(unwrap)}
      onLink={(url) => {
        void window.zpiQuickChat
          .openExternal(url)
          .then(unwrap)
          .catch((reason) => onError(userErrorMessage(reason)));
      }}
      onFile={() => onError("快速对话不支持预览本地文件")}
    />
  );
}
