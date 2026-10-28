import { useEffect, useRef, useState } from "react";
import type { ModelWaitStatus } from "zpi-ai";
import { userErrorMessage } from "../user-error.ts";
import { Notice } from "./Notice.tsx";

/** A single local clock; waiting does not send periodic IPC or persist timer ticks. */
export function ModelWaitNotice({
  wait,
  onRetry,
}: {
  wait?: ModelWaitStatus | null;
  onRetry?: () => Promise<unknown>;
}) {
  const [now, setNow] = useState(Date.now);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const retryPending = useRef(false);
  const revision = useRef(0);
  const phase = wait?.phase;
  const startedAt = wait?.startedAt;
  useEffect(() => {
    revision.current++;
    retryPending.current = false;
    setPending(false);
    setError("");
    setNow(Date.now());
    const timer = startedAt === undefined ? undefined : setInterval(() => setNow(Date.now()), 1000);
    return () => {
      revision.current++;
      retryPending.current = false;
      clearInterval(timer);
    };
  }, [phase, startedAt]);
  const retry = () => {
    if (!onRetry || retryPending.current) return;
    retryPending.current = true;
    const current = revision.current;
    setPending(true);
    setError("");
    void Promise.resolve()
      .then(() => (current === revision.current ? onRetry() : undefined))
      .catch((reason) => {
        if (current === revision.current) setError(userErrorMessage(reason));
      })
      .finally(() => {
        if (current !== revision.current) return;
        retryPending.current = false;
        setPending(false);
      });
  };
  const seconds = Math.max(0, Math.floor((now - (startedAt ?? now)) / 1000));
  const status = wait
    ? phase === "first_response"
      ? "正在等待模型首次响应"
      : "模型暂时没有新输出"
    : "正在等待重新连接";
  const guidance = onRetry ? "可以继续等待，或立即重试。" : "可以继续等待。";
  const message = wait ? `${status}，已等待 ${seconds} 秒。${guidance}` : `${status}。${guidance}`;
  return (
    <>
      <Notice
        scope="turn"
        tone={error ? "error" : "info"}
        message={error || message}
        announce={false}
        action={
          onRetry
            ? { label: pending ? "正在重试…" : "立即重试", onClick: retry, disabled: pending }
            : undefined
        }
      />
      <span className="sr-only" role={error ? "alert" : "status"}>
        {error || (pending ? "正在重试模型请求。" : `${status}。${guidance}`)}
      </span>
    </>
  );
}
