// Error tooltip presentation follows ZCode ToolCallBlocks/ToolLayout.tsx (Apache-2.0).
import * as Tooltip from "@radix-ui/react-tooltip";
import { Check, Copy } from "lucide-react";
import { useEffect, useState } from "react";

export function ToolFailure({ text, onCopy }: { text: string; onCopy?: (text: string) => Promise<void> }) {
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <Tooltip.Provider delayDuration={0}>
      <Tooltip.Root>
        <Tooltip.Trigger asChild>
          <button type="button" className="tool-failure" aria-label="工具执行失败">
            失败
          </button>
        </Tooltip.Trigger>
        <Tooltip.Portal>
          <Tooltip.Content
            side="top"
            align="end"
            sideOffset={4}
            collisionPadding={12}
            className="tool-error-tooltip"
          >
            <pre className="tool-error-content">{text}</pre>
            <button
              type="button"
              className="tool-error-copy"
              disabled={!onCopy}
              aria-label={copied ? "已复制错误" : "复制错误详情"}
              title={copied ? "已复制" : "复制错误详情"}
              onClick={async () => {
                try {
                  await onCopy?.(text);
                  setCopied(true);
                  setError(false);
                } catch {
                  setError(true);
                }
              }}
            >
              {copied ? <Check size={14} /> : <Copy size={14} />}
            </button>
            {error && <small role="alert">复制失败，请重试</small>}
          </Tooltip.Content>
        </Tooltip.Portal>
      </Tooltip.Root>
    </Tooltip.Provider>
  );
}
