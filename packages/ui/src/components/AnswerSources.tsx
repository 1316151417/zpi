import * as Popover from "@radix-ui/react-popover";
import { Globe, X } from "lucide-react";
import { useEffect, useId, useState } from "react";
import type { WebOpenOptions } from "../link-target.ts";
import {
  type AnswerSource,
  answerSourceIconLoader,
  answerSourceSites,
  openAnswerSource,
  type ReadWebSourceIcon,
} from "./answer-sources.ts";
import "./answer-sources.css";

interface IconContext {
  sessionId?: string;
  runId: string;
  readIcon?: ReadWebSourceIcon;
  refresh?: boolean;
}

export function AnswerSourceIcon({
  source,
  sessionId,
  runId,
  readIcon,
  refresh,
}: IconContext & { source: AnswerSource }) {
  const key = JSON.stringify([sessionId, runId, source.url, source.siteIcon]);
  const [loaded, setLoaded] = useState<{ key: string; src?: string }>();
  useEffect(() => {
    if (!readIcon || !sessionId || !source.siteIcon) return;
    let active = true;
    void answerSourceIconLoader(readIcon)(sessionId, runId, source).then((src) => {
      if (active) setLoaded({ key, src });
    });
    return () => {
      active = false;
    };
  }, [readIcon, sessionId, runId, source.url, source.siteIcon, refresh]);
  const src = readIcon && sessionId && source.siteIcon && loaded?.key === key ? loaded.src : undefined;
  return (
    <span className="answer-source-icon" aria-hidden="true">
      {src ? <img src={src} alt="" onError={() => setLoaded({ key })} /> : <Globe size={15} />}
    </span>
  );
}

export function AnswerSourceList({
  sources,
  onLink,
  onOpenSource,
  ...icons
}: IconContext & {
  sources: AnswerSource[];
  onLink: (url: string, options?: WebOpenOptions) => void;
  onOpenSource?: () => void;
}) {
  return (
    <ul className="answer-sources-list" aria-label="来源网页">
      {sources.map((source) => (
        <li key={source.url} className="answer-source-item">
          <button
            type="button"
            className="answer-source-link"
            onClick={() => {
              if (openAnswerSource(source.url, onLink)) onOpenSource?.();
            }}
            title={source.url}
          >
            <span className="answer-source-site">
              <AnswerSourceIcon source={source} {...icons} />
              <span>{source.siteName}</span>
            </span>
            <span className="answer-source-title">{source.title}</span>
            {source.date && <span className="answer-source-date">{source.date}</span>}
            {source.excerpt && <span className="answer-source-excerpt">{source.excerpt}</span>}
          </button>
        </li>
      ))}
    </ul>
  );
}

export function AnswerSources({
  sources,
  onLink,
  ...icons
}: IconContext & {
  sources: AnswerSource[];
  onLink: (url: string, options?: WebOpenOptions) => void;
}) {
  const [open, setOpen] = useState(false);
  const titleId = useId();
  if (!sources.length) return null;
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          className="message-action answer-sources-trigger"
          aria-label={`来源，${sources.length} 个网页`}
        >
          <span className="answer-sources-icons" aria-hidden="true">
            {answerSourceSites(sources).map((source) => (
              <AnswerSourceIcon key={source.hostname} source={source} {...icons} refresh={open} />
            ))}
          </span>
          <span>来源</span>
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          className="answer-sources-popover"
          side="top"
          align="end"
          sideOffset={8}
          collisionPadding={12}
          aria-labelledby={titleId}
        >
          <div className="answer-sources-heading">
            <span id={titleId}>
              来源 <span className="answer-sources-count">{sources.length}</span>
            </span>
            <Popover.Close className="answer-sources-close" aria-label="关闭来源">
              <X size={14} aria-hidden="true" />
            </Popover.Close>
          </div>
          <AnswerSourceList
            sources={sources}
            onLink={onLink}
            onOpenSource={() => setOpen(false)}
            {...icons}
          />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
