import { useEffect, useRef, useState } from "react";
import type { ModelWaitStatus } from "zpi-ai";
import { userErrorMessage } from "../user-error.ts";

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
  const status = wait ? (phase === "first_response" ? "等待模型响应" : "等待新输出") : "正在等待重新连接";
  const guidance = onRetry ? "可以继续等待，或立即重试。" : "可以继续等待。";
  return (
    <div className="model-wait">
      {(wait || error) && (
        <span className={`model-wait-message${error ? " model-wait-error" : ""}`}>
          {error || `${status} · ${seconds} 秒`}
        </span>
      )}
      {onRetry && (
        <button
          type="button"
          className="model-wait-retry"
          aria-label={pending ? "正在重试" : "立即重试"}
          disabled={pending}
          onClick={retry}
        >
          {pending ? "重试中…" : "重试"}
        </button>
      )}
      <span className="sr-only" role={error ? "alert" : "status"}>
        {error || (pending ? "正在重试模型请求。" : `${status}。${guidance}`)}
      </span>
    </div>
  );
}
