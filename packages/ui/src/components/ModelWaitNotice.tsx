import type { ModelRetryStatus, ModelWaitStatus } from "@zpi-dev/ai";
import { useEffect, useRef, useState } from "react";
import { userErrorMessage } from "../user-error.ts";

/** A single local clock; waiting does not send periodic IPC or persist timer ticks. */
export function ModelWaitNotice({
  wait,
  retryStatus,
  onRetry,
}: {
  wait?: ModelWaitStatus | null;
  retryStatus?: ModelRetryStatus | null;
  onRetry?: () => Promise<unknown>;
}) {
  const [now, setNow] = useState(Date.now);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const retryPending = useRef(false);
  const revision = useRef(0);
  const phase = wait?.phase;
  const startedAt = retryStatus ? undefined : wait?.startedAt;
  const origin = retryStatus?.origin;
  const attempt = retryStatus?.attempt;
  const serverRetryAt = retryStatus?.serverRetryAt;
  const canRetry = Boolean(onRetry && serverRetryAt === undefined);
  useEffect(() => {
    revision.current++;
    retryPending.current = false;
    setPending(false);
    setError("");
    setNow(Date.now());
    const timer =
      startedAt === undefined && serverRetryAt === undefined
        ? undefined
        : setInterval(() => setNow(Date.now()), 1000);
    return () => {
      revision.current++;
      retryPending.current = false;
      clearInterval(timer);
    };
  }, [phase, startedAt, origin, attempt, serverRetryAt]);
  const retry = () => {
    if (!onRetry || !canRetry || retryPending.current) return;
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
  const remaining = Math.max(0, Math.ceil(((serverRetryAt ?? now) - now) / 1000));
  const countdown = `${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, "0")}`;
  const waitingLabel = phase === "first_response" ? "等待模型响应" : "等待新输出";
  const status =
    serverRetryAt !== undefined
      ? "模型过载"
      : pending || retryStatus?.origin === "manual"
        ? "正在重新请求"
        : retryStatus
          ? "重新连接中"
          : wait
            ? waitingLabel
            : "正在等待重新连接";
  const message =
    retryStatus && serverRetryAt !== undefined
      ? `模型过载，${countdown} 后自动重试（${retryStatus.attempt}/${retryStatus.maxRetries}）`
      : pending || retryStatus?.origin === "manual"
        ? `${status}…`
        : retryStatus
          ? `${status}… ${retryStatus.attempt}/${retryStatus.maxRetries}`
          : `${status} · ${seconds} 秒`;
  const guidance = canRetry ? "可以继续等待，或立即重试。" : "可以继续等待。";
  return (
    <div className="model-wait">
      {(wait || retryStatus || pending || error) && (
        <span
          className={`model-wait-message${error ? " model-wait-error" : ""}`}
          data-testid={retryStatus ? "api-retry-status" : undefined}
          title={retryStatus?.errorStatus == null ? undefined : `HTTP ${retryStatus.errorStatus}`}
        >
          {error || message}
        </span>
      )}
      {canRetry && (
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
        {error || `${status}。${guidance}`}
      </span>
    </div>
  );
}
